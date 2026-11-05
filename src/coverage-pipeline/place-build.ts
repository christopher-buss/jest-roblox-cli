import * as crypto from "node:crypto";
import * as path from "node:path";

import type { CodeBundleArtifact } from "../staging/code-bundle.ts";
import { CODE_SPLIT_PASS_VERSION } from "../staging/code-split.ts";
import type { UnwrappedBuildPlaceOptions } from "../staging/place-builder.ts";
import { buildCodeBundle, buildPlaceAsync } from "../staging/place-builder.ts";
import type { StubMount } from "../staging/synthesizer-types.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { INSTRUMENTER_VERSION } from "./instrumenter.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
} from "./manifest.ts";
import { MANIFEST_VERSION, writeManifest } from "./manifest.ts";
import type { CoverageInputs, PrepareCoverageResult, ShadowRootsResult } from "./prepare-types.ts";

export const SHADOW_DIR = ".jest-roblox/coverage";

/** Outside `SHADOW_DIR`, so a cold wipe keeps the place. */
export const PLACE_DIR = ".jest-roblox/place";

/**
 * The place this pipeline builds, and the bundle a harness build splits out.
 */
export const COVERAGE_PLACE_FILE: string = path.join(PLACE_DIR, "game.rbxl");

/** What the coverage place build reads, once the shadow is populated. */
export interface BuildCoveragePlaceOptions {
	/** Runs the place build. */
	childProcess: ChildProcessRunner;
	/** Present for a Harness Place; absent builds the whole place. */
	codeRoots: ReadonlyArray<PosixRoot> | undefined;
	/** File system the build reads and writes through. */
	fileSystem: FileSystem;
	/** Directory of the package under test. */
	packageDirectory: string;
	/** Rojo project the place is built from. */
	rojoProjectPath: string;
	/** Instrumented roots and spine the place mounts. */
	shadow: Pick<ShadowRootsResult, "coverageRoots" | "coverageSpine">;
	/** Stubs the bake mounts into the place. */
	stubMounts: Array<StubMount>;
}

interface WriteManifestOptions {
	allFiles: Record<string, InstrumentedFileRecord>;
	buildId: string;
	codeSplitKey: string | undefined;
	copyIgnoreHash: string;
	coverageUniverseHash: string | undefined;
	fileSystem: FileSystem;
	luauRoots: Array<string>;
	manifestPath: string;
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
	placeFile: string;
	rojoInputsHash: string | undefined;
}

/**
 * What the split would emit, as the one string the cached place has to still
 * answer for: the pass version and the Code Roots it ran over, or nothing at
 * all for a run that builds the whole place.
 *
 * The place-reuse key folds these for every other build, and reaches no build
 * on this path — the gate below is this pipeline's own. Without them a bumped
 * pass version or a moved Code Root hands back a harness the old rule built,
 * and a run whose Code Roots changed is handed the other answer's place: a
 * harness holds none of the run's code, so every test goes
 * missing rather than fails.
 *
 * The roots go in as they are rather than hashed: the manifest already records
 * `luauRoots` the same way, and a reader comparing two runs wants to see which
 * root moved.
 * @param codeRoots - Code Roots of a Harness Place build, if any.
 * @returns The split key, or undefined for a whole-place build.
 */
export function describeCodeSplit(
	codeRoots: ReadonlyArray<PosixRoot> | undefined,
): string | undefined {
	return codeRoots === undefined
		? undefined
		: [String(CODE_SPLIT_PASS_VERSION), ...codeRoots].join("\n");
}

/**
 * Build the `.rbxl` first, then write the manifest. The order matters: a failed
 * `buildRojoProject` throws before the coverage manifest is written, so an
 * interrupted run never leaves a manifest claiming an artifact that isn't on
 * disk. The caller owns Build Manifest emission (it alone knows the full place
 * set), keeping that write a single atomic operation.
 * @param options - Place build options, coverage inputs and shadow result.
 * @returns Build id, code bundle, place artifact and written manifest.
 * @rejects When the place build fails; no manifest is written then.
 */
export async function buildPlaceAndManifestAsync({
	build,
	inputs,
	shadow,
}: {
	build: BuildCoveragePlaceOptions;
	inputs: CoverageInputs;
	shadow: ShadowRootsResult;
}): Promise<Pick<PrepareCoverageResult, "buildId" | "codeBundle" | "coveragePlace" | "manifest">> {
	const coveragePlace = await buildPlaceAsync(coveragePlaceOptions(build));

	const buildId = crypto.randomUUID();
	const manifest = buildAndWriteManifest({
		allFiles: shadow.files,
		buildId,
		codeSplitKey: describeCodeSplit(build.codeRoots),
		copyIgnoreHash: inputs.copyIgnoreHash,
		coverageUniverseHash: inputs.universe?.digest,
		fileSystem: inputs.fileSystem,
		luauRoots: inputs.luauRoots,
		manifestPath: inputs.manifestPath,
		nonInstrumentedFiles: shadow.nonInstrumentedFiles,
		placeFile: COVERAGE_PLACE_FILE,
		rojoInputsHash: inputs.rojoInputsHash,
	});

	return { buildId, codeBundle: coveragePlace.codeBundle, coveragePlace, manifest };
}

/**
 * The bundle for a place this run reused rather than built.
 * @param build - Place build options.
 * @returns The Code Bundle, or undefined for a whole-place build.
 */
export function reuseCodeBundle(build: BuildCoveragePlaceOptions): CodeBundleArtifact | undefined {
	const { codeRoots } = build;
	return codeRoots === undefined
		? undefined
		: buildCodeBundle({ ...coveragePlaceOptions(build), codeRoots });
}

/**
 * The synthesizer input the coverage place and its Code Bundle share.
 *
 * One object for both, because a bundle split from a different project than the
 * place was built from would carry mounts the harness still holds.
 * @param options - Place build options.
 * @returns Synthesizer input.
 */
function coveragePlaceOptions({
	childProcess,
	codeRoots,
	fileSystem,
	packageDirectory,
	rojoProjectPath,
	shadow,
	stubMounts,
}: BuildCoveragePlaceOptions): UnwrappedBuildPlaceOptions {
	return {
		childProcess,
		codeRoots,
		fileSystem,
		// The coverage place is shared by every backend. studio-cli opens it
		// directly and drives the plugin's Run-mode runner, which refuses to run
		// unless LoadString is enabled; enabling it here is benign for the
		// open-cloud path (OCALE does not gate on it). Forcing it on at build
		// time keeps "studio-cli only selects the coverage place" true.
		loadStringEnabled: true,
		packages: [
			{
				coverageRoots: shadow.coverageRoots,
				coverageSpine: shadow.coverageSpine,
				packageDirectory: path.resolve(packageDirectory),
				rojoProjectPath: path.resolve(rojoProjectPath),
				stubMounts,
			},
		],
		placeFile: COVERAGE_PLACE_FILE,
		projectFile: path.join(PLACE_DIR, path.basename(rojoProjectPath)),
		wrap: false,
	};
}

function buildAndWriteManifest({
	allFiles,
	buildId,
	codeSplitKey,
	copyIgnoreHash,
	coverageUniverseHash,
	fileSystem,
	luauRoots,
	manifestPath,
	nonInstrumentedFiles,
	placeFile,
	rojoInputsHash,
}: WriteManifestOptions): CoverageManifest {
	const generatedAtDate = new Date();
	const manifest: CoverageManifest = {
		buildId,
		codeSplitKey,
		copyIgnoreHash,
		coverageUniverseHash,
		files: allFiles,
		generatedAt: generatedAtDate.toISOString(),
		instrumenterVersion: INSTRUMENTER_VERSION,
		luauRoots,
		nonInstrumentedFiles,
		placeFilePath: placeFile,
		rojoInputsHash,
		shadowDir: SHADOW_DIR,
		version: MANIFEST_VERSION,
	};

	writeManifest({ filePath: manifestPath, fileSystem, manifest });

	return manifest;
}
