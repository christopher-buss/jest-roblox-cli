import * as fs from "node:fs";
import * as path from "node:path";

import type { BuildManifestArtifact } from "../coverage-pipeline/build-manifest.ts";
import type { CoverageManifest } from "../coverage-pipeline/manifest.ts";
import { hashFile } from "../utils/hash.ts";
import { buildWithRojo } from "../utils/rojo-builder.ts";
import { demotePinnedMounts, PINNED_MOUNT_PASS_VERSION } from "./pinned-mounts.ts";
import {
	computePlaceInputsKey,
	readPlaceReuseRecord,
	writePlaceReuseRecord,
} from "./place-reuse.ts";
import { relativizeProjectPaths } from "./relativize-paths.ts";
import type { PackageDescriptor } from "./synthesizer.ts";
import { synthesize } from "./synthesizer.ts";

/** Where {@link demotePinnedMounts} parks its Folder-rooted stand-ins. */
const PINNED_SHADOW_DIR = "pinned-shadow";

export interface PlaceReuseOptions {
	/** Where the previous build's key and place hash are recorded. */
	cacheFile: string;
	/** Coverage manifests standing in for a walk of the instrumented trees. */
	manifests: Array<CoverageManifest>;
	/** Shadow mounts the manifests cover, kept out of the walk. */
	shadowRoots: Array<string>;
}

export interface BuildPlaceOptions {
	/**
	 * Force `ServerScriptService.LoadStringEnabled = true` on the built place.
	 * Used by studio-cli's Clean Place, whose Run-mode runner gates on
	 * LoadString. Forwarded verbatim to {@link synthesize}.
	 */
	loadStringEnabled?: boolean | undefined;
	packages: Array<PackageDescriptor>;
	placeFile: string;
	projectFile: string;
	/**
	 * Skip the rojo build when every input still hashes the same as the last
	 * one. Omit to always build — the callers that gate reuse upstream (multi's
	 * coverage path) would only be double-gating.
	 */
	reuse?: PlaceReuseOptions | undefined;
	wrap?: boolean | undefined;
}

/** A cache file to consult, paired with the key its contents must match. */
interface ReusePlan {
	cacheFile: string;
	inputsKey: string;
}

/**
 * Synthesize a rojo project for `packages`, write it to `projectFile`, build
 * the `.rbxl` at `placeFile`, and hash the result into a
 * `BuildManifestArtifact`. The single seam every place build routes through: a
 * Clean Place and a Coverage-Instrumented Place differ only in whether the
 * descriptors carry `coverageRoots`.
 */
export function buildPlace({
	loadStringEnabled,
	packages,
	placeFile,
	projectFile,
	reuse,
	wrap,
}: BuildPlaceOptions): BuildManifestArtifact {
	const projectDirectory = path.dirname(projectFile);
	const projectJson = synthesize({ loadStringEnabled, packages, wrap });

	// Planned before anything is written or built, so a reused place pays for
	// neither of the two passes below — see `PlaceInputsKeyOptions.projectJson`
	// for why a key over the synthesized project can answer for what they write.
	const plan = planReuse({
		projectFile,
		projectJson: relativizeProjectPaths(projectJson, projectDirectory),
		reuse,
	});
	const reused = plan === undefined ? undefined : tryReuse(plan, placeFile);
	if (reused !== undefined) {
		return reused;
	}

	const artifact = stageAndBuild({ placeFile, projectDirectory, projectFile, projectJson });
	if (plan !== undefined) {
		writePlaceReuseRecord(plan.cacheFile, {
			inputsKey: plan.inputsKey,
			placeHash: artifact.hash,
		});
	}

	return artifact;
}

/**
 * Write the project the build reads, then build the place from it.
 *
 * Relative `$path`s, written last: rojo matches `globIgnorePaths` against the
 * path as the project expresses it, so absolute ones would leave the ignore
 * list inert. The pinned-mount pass runs before it for the same reason — the
 * ignore entries it adds are expressed in that relative frame.
 */
function stageAndBuild({
	placeFile,
	projectDirectory,
	projectFile,
	projectJson,
}: {
	placeFile: string;
	projectDirectory: string;
	projectFile: string;
	projectJson: string;
}): BuildManifestArtifact {
	const staged = relativizeProjectPaths(
		demotePinnedMounts({
			projectDirectory,
			projectJson,
			shadowDirectory: path.join(projectDirectory, PINNED_SHADOW_DIR),
		}),
		projectDirectory,
	);
	fs.mkdirSync(projectDirectory, { recursive: true });
	fs.writeFileSync(projectFile, staged);
	// `rojo build -o` fails if the output directory is missing, so ensure it
	// exists for every caller rather than relying on each one to pre-create it.
	fs.mkdirSync(path.dirname(placeFile), { recursive: true });

	buildWithRojo(projectFile, placeFile);
	return { hash: hashFile(placeFile), path: placeFile };
}

/**
 * The cache file to consult and the key to match it against, or `undefined`
 * when this build has no cache to work with — reuse was not asked for, or the
 * inputs would not hash. Pairing the two means a caller never holds a key
 * without somewhere to put it.
 */
function planReuse({
	projectFile,
	projectJson,
	reuse,
}: {
	projectFile: string;
	projectJson: string;
	reuse: PlaceReuseOptions | undefined;
}): ReusePlan | undefined {
	if (reuse === undefined) {
		return undefined;
	}

	const inputsKey = computePlaceInputsKey({
		manifests: reuse.manifests,
		projectFile,
		projectJson,
		shadowRoots: reuse.shadowRoots,
		// The pinned-mount pass is the only staging code the key cannot read
		// off its own inputs: the path rewrite is already applied to the text
		// above, so a change to that rule moves the key on its own.
		stagingVersion: PINNED_MOUNT_PASS_VERSION,
	});

	return inputsKey === undefined ? undefined : { cacheFile: reuse.cacheFile, inputsKey };
}

function hashPlace(placeFile: string): string | undefined {
	try {
		return hashFile(placeFile);
	} catch {
		// Absent or unreadable: no hash can match, so the caller rebuilds.
		return undefined;
	}
}

/**
 * The built place from last time, when every input still hashes the same and
 * the place on disk is still the one that key was recorded against. Any doubt
 * — no record, a drifted key, a missing or altered place — rebuilds, so the
 * cache can only ever cost time, never correctness.
 *
 * The place is re-hashed rather than merely stat'd. A build killed part-way
 * leaves a half-written `.rbxl` and no new record, so the record still names
 * the run before it: an existence check would match the key and hand that
 * truncated place out, with the previous hash riding along into every Build
 * Manifest. Reading it back costs a fraction of building it again.
 */
function tryReuse(plan: ReusePlan, placeFile: string): BuildManifestArtifact | undefined {
	const record = readPlaceReuseRecord(plan.cacheFile);
	if (record?.inputsKey !== plan.inputsKey || hashPlace(placeFile) !== record.placeHash) {
		return undefined;
	}

	return { hash: record.placeHash, path: placeFile };
}
