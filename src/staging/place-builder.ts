import * as path from "node:path";

import type { BuildManifestArtifact } from "../coverage-pipeline/build-manifest.ts";
import type { CoverageManifest } from "../coverage-pipeline/manifest.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { hashFileAsync } from "../utils/hash.ts";
import { omitUndefined } from "../utils/omit-undefined.ts";
import { buildWithRojoAsync } from "../utils/rojo-builder.ts";
import { demotePinnedMountsAsync, PINNED_MOUNT_PASS_VERSION } from "./pinned-mounts.ts";
import {
	computePlaceInputsKeyAsync,
	readPlaceReuseRecord,
	writePlaceReuseRecord,
} from "./place-reuse.ts";
import { relativizeProjectPaths } from "./relativize-paths.ts";
import { poolSharedMounts, SHARED_POOL_PASS_VERSION } from "./shared-pool.ts";
import type { PackageDescriptor } from "./synthesizer.ts";
import { synthesize } from "./synthesizer.ts";

/** Where {@link demotePinnedMountsAsync} parks its Folder-rooted stand-ins. */
const PINNED_SHADOW_DIR = "pinned-shadow";
/**
 * One entry per pass {@link stageAndBuildAsync} runs, because those are the
 * only staging code the reuse key cannot read off its own inputs: they run
 * after the key is computed, so nothing on disk moves when what they emit
 * changes. A pass added to that fold without an entry here reads as current
 * and hands out a place built by its previous rule.
 */
const STAGING_PASS_VERSIONS = [PINNED_MOUNT_PASS_VERSION, SHARED_POOL_PASS_VERSION];

export interface PlaceReuseOptions {
	/** Where the previous build's key and place hash are recorded. */
	cacheFile: string;
	/** Forwarded to `openInputDigestCache`, which says what it claims. */
	digestCacheFile: string;
	/** Coverage manifests standing in for a walk of the instrumented trees. */
	manifests: Array<CoverageManifest>;
	/** Shadow mounts the manifests cover, kept out of the walk. */
	shadowRoots: Array<string>;
}

export interface BuildPlaceOptions {
	/**
	 * The Place Content Id to stamp into the built place and record on the
	 * artifact. Forwarded verbatim to {@link synthesize}, so it lands in the
	 * project text the reuse key covers — a place built for another id can
	 * never be reused for this one. Omit to build a place with no identity of
	 * its own.
	 */
	contentId?: string | undefined;
	/** Where the place is staged and built. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
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
export async function buildPlaceAsync({
	contentId,
	fileSystem = nodeFileSystem,
	loadStringEnabled,
	packages,
	placeFile,
	projectFile,
	reuse,
	wrap,
}: BuildPlaceOptions): Promise<BuildManifestArtifact> {
	const projectDirectory = path.dirname(projectFile);
	const projectJson = synthesize({ contentId, fileSystem, loadStringEnabled, packages, wrap });

	// Planned before anything is written or built, so a reused place pays for
	// neither of the two passes below — see `PlaceInputsKeyOptions.projectJson`
	// for why a key over the synthesized project can answer for what they write.
	const plan = await planReuseAsync({
		fileSystem,
		projectFile,
		projectJson: relativizeProjectPaths(projectJson, projectDirectory),
		reuse,
	});
	const reused =
		plan === undefined ? undefined : await tryReuseAsync(fileSystem, plan, placeFile);
	if (reused !== undefined) {
		return omitUndefined({ ...reused, contentId });
	}

	const artifact = await stageAndBuildAsync({
		fileSystem,
		placeFile,
		projectDirectory,
		projectFile,
		projectJson,
	});
	if (plan !== undefined) {
		writePlaceReuseRecord(
			plan.cacheFile,
			{ inputsKey: plan.inputsKey, placeHash: artifact.hash },
			fileSystem,
		);
	}

	// Recorded as well as stamped, because the consumer that compares the two
	// reads its half off the artifact.
	return omitUndefined({ ...artifact, contentId });
}

/**
 * Write the project the build reads, then build the place from it.
 *
 * Relative `$path`s, written last: rojo matches `globIgnorePaths` against the
 * path as the project expresses it, so absolute ones would leave the ignore
 * list inert. The pinned-mount pass runs before it for the same reason — the
 * ignore entries it adds are expressed in that relative frame.
 *
 * The shared pool runs before the pinned-mount pass, so the pinned pass sees
 * one copy of each offending mount and builds one stand-in for it rather than
 * one per package.
 */
async function stageAndBuildAsync({
	fileSystem,
	placeFile,
	projectDirectory,
	projectFile,
	projectJson,
}: {
	fileSystem: FileSystem;
	placeFile: string;
	projectDirectory: string;
	projectFile: string;
	projectJson: string;
}): Promise<BuildManifestArtifact> {
	const staged = relativizeProjectPaths(
		await demotePinnedMountsAsync({
			fileSystem,
			projectDirectory,
			projectJson: poolSharedMounts({ fileSystem, projectDirectory, projectJson }),
			shadowDirectory: path.join(projectDirectory, PINNED_SHADOW_DIR),
		}),
		projectDirectory,
	);
	fileSystem.mkdirSync(projectDirectory, { recursive: true });
	fileSystem.writeFileSync(projectFile, staged);
	// `rojo build -o` fails if the output directory is missing, so ensure it
	// exists for every caller rather than relying on each one to pre-create it.
	fileSystem.mkdirSync(path.dirname(placeFile), { recursive: true });

	await buildWithRojoAsync(projectFile, placeFile);
	return { hash: await hashFileAsync(placeFile, fileSystem), path: placeFile };
}

/**
 * The cache file to consult and the key to match it against, or `undefined`
 * when this build has no cache to work with — reuse was not asked for, or the
 * inputs would not hash. Pairing the two means a caller never holds a key
 * without somewhere to put it.
 */
async function planReuseAsync({
	fileSystem,
	projectFile,
	projectJson,
	reuse,
}: {
	fileSystem: FileSystem;
	projectFile: string;
	projectJson: string;
	reuse: PlaceReuseOptions | undefined;
}): Promise<ReusePlan | undefined> {
	if (reuse === undefined) {
		return undefined;
	}

	const inputsKey = await computePlaceInputsKeyAsync({
		digestCacheFile: reuse.digestCacheFile,
		fileSystem,
		manifests: reuse.manifests,
		projectFile,
		projectJson,
		shadowRoots: reuse.shadowRoots,
		// The path rewrite is not among them: it is already applied to the text
		// this key is computed over, so a change to that rule moves the key on
		// its own.
		stagingVersions: STAGING_PASS_VERSIONS,
	});

	return inputsKey === undefined ? undefined : { cacheFile: reuse.cacheFile, inputsKey };
}

async function hashPlaceAsync(
	fileSystem: FileSystem,
	placeFile: string,
): Promise<string | undefined> {
	try {
		return await hashFileAsync(placeFile, fileSystem);
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
async function tryReuseAsync(
	fileSystem: FileSystem,
	plan: ReusePlan,
	placeFile: string,
): Promise<BuildManifestArtifact | undefined> {
	const record = readPlaceReuseRecord(plan.cacheFile, fileSystem);
	if (
		record?.inputsKey !== plan.inputsKey ||
		(await hashPlaceAsync(fileSystem, placeFile)) !== record.placeHash
	) {
		return undefined;
	}

	return { hash: record.placeHash, path: placeFile };
}
