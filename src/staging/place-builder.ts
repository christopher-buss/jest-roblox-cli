import * as path from "node:path";
import { isDefined, pickBy } from "remeda";

import type { BuildManifestArtifact } from "../coverage-data/build-manifest.ts";
import type { CoverageManifest } from "../coverage-data/manifest.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { hashFileAsync } from "../utils/hash.ts";
import { buildWithRojoAsync } from "../utils/rojo-builder.ts";
import { demotePinnedMountsAsync, PINNED_MOUNT_PASS_VERSION } from "./pinned-mounts.ts";
import {
	computePlaceInputsKeyAsync,
	readPlaceReuseRecord,
	writePlaceReuseRecord,
} from "./place-reuse.ts";
import { relativizeProjectPaths } from "./relativize-paths.ts";
import { poolSharedMounts, SHARED_POOL_PASS_VERSION } from "./shared-pool.ts";
import type { PackageSynthesisInput } from "./synthesizer-types.ts";
import { synthesize } from "./synthesizer.ts";

const PINNED_SHADOW_DIR = "pinned-shadow";
// One entry per pass in `stageAndBuildAsync`, or stale places are reused.
const STAGING_PASS_VERSIONS = [PINNED_MOUNT_PASS_VERSION, SHARED_POOL_PASS_VERSION];

/** Where a build records its reuse key and what the key may skip walking. */
export interface PlaceReuseOptions {
	/** Where the previous build's key and place hash are recorded. */
	cacheFile: string;
	/** Computes the reuse key. */
	computeInputsKey?: typeof computePlaceInputsKeyAsync | undefined;
	/** Where input digests are cached between runs. */
	digestCacheFile: string;
	/** Rebuild even when the staged inputs match the prior record. */
	forceRebuild?: boolean | undefined;
	/** Coverage manifests standing in for a walk of the instrumented trees. */
	manifests?: Array<CoverageManifest> | undefined;
	/** Shadow mounts the manifests cover, kept out of the walk. */
	shadowRoots?: Array<string> | undefined;
}

/** Inputs to {@link buildPlaceAsync}. */
export type BuildPlaceOptions = BuildPlaceOptionsBase & PackageSynthesisInput;

interface BuildPlaceOptionsBase {
	childProcess: ChildProcessRunner;
	contentId?: string | undefined;
	fileSystem: FileSystem;
	loadStringEnabled?: boolean | undefined;
	placeFile: string;
	projectFile: string;
	reuse?: PlaceReuseOptions | undefined;
}

interface ReusePlan {
	cacheFile: string;
	inputsKey: string;
}

interface PlaceArtifactOptions {
	childProcess: ChildProcessRunner;
	fileSystem: FileSystem;
	forceRebuild?: boolean | undefined;
	placeFile: string;
	plan: ReusePlan | undefined;
	projectDirectory: string;
	projectFile: string;
	projectJson: string;
}

interface PlaceBuildResult {
	artifact: BuildManifestArtifact;
	rebuilt: boolean;
}

/**
 * Synthesize, build and hash the place for `packages`.
 * @param options - Packages, place and project paths, and optional reuse.
 * @returns The place artifact and whether it was rebuilt.
 * @rejects When a buried pinned class is found or rojo fails.
 */
export async function buildPlaceAsync(options: BuildPlaceOptions): Promise<PlaceBuildResult> {
	const { childProcess, contentId, fileSystem, placeFile, projectFile, reuse } = options;
	const projectDirectory = path.dirname(projectFile);
	const projectJson = synthesize(options);

	const plan = await planReuseAsync({
		fileSystem,
		projectFile,
		projectJson: relativizeProjectPaths(projectJson, projectDirectory),
		reuse,
		stagingVersions: STAGING_PASS_VERSIONS,
	});
	const artifact = await reuseOrBuildPlaceAsync({
		childProcess,
		fileSystem,
		forceRebuild: reuse?.forceRebuild,
		placeFile,
		plan,
		projectDirectory,
		projectFile,
		projectJson,
	});
	const { rebuilt: wasRebuilt, ...place } = artifact;
	return { artifact: pickBy({ ...place, contentId }, isDefined), rebuilt: wasRebuilt };
}

/**
 * Order: pool, then pinned mounts, then relativize last; rojo matches
 * `globIgnorePaths` against relative `$path`s.
 *
 * @param options - Project text, paths, adapters and the reuse plan.
 * @returns The built place's path and hash.
 * @rejects When a buried pinned class is found or rojo fails.
 */
async function stageAndBuildAsync({
	childProcess,
	fileSystem,
	placeFile,
	plan,
	projectDirectory,
	projectFile,
	projectJson,
}: PlaceArtifactOptions): Promise<BuildManifestArtifact & { rebuilt: boolean }> {
	const staged = relativizeProjectPaths(
		await demotePinnedMountsAsync({
			childProcess,
			fileSystem,
			projectDirectory,
			projectJson: poolSharedMounts({ fileSystem, projectDirectory, projectJson }),
			shadowDirectory: path.join(projectDirectory, PINNED_SHADOW_DIR),
		}),
		projectDirectory,
	);
	fileSystem.mkdirSync(projectDirectory, { recursive: true });
	fileSystem.writeFileSync(projectFile, staged);
	fileSystem.mkdirSync(path.dirname(placeFile), { recursive: true });

	await buildWithRojoAsync({ childProcess, outputPath: placeFile, projectPath: projectFile });
	const hash = await hashFileAsync(placeFile, fileSystem);
	if (plan !== undefined) {
		writePlaceReuseRecord({
			cacheFile: plan.cacheFile,
			fileSystem,
			record: { inputsKey: plan.inputsKey, placeHash: hash },
		});
	}

	return { hash, path: placeFile, rebuilt: true };
}

async function hashPlaceAsync(
	fileSystem: FileSystem,
	placeFile: string,
): Promise<string | undefined> {
	try {
		return await hashFileAsync(placeFile, fileSystem);
	} catch {
		return undefined;
	}
}

async function tryReuseAsync({
	fileSystem,
	placeFile,
	plan,
}: {
	fileSystem: FileSystem;
	placeFile: string;
	plan: ReusePlan;
}): Promise<(BuildManifestArtifact & { rebuilt: boolean }) | undefined> {
	const record = readPlaceReuseRecord(plan.cacheFile, fileSystem);
	if (
		record?.inputsKey !== plan.inputsKey ||
		(await hashPlaceAsync(fileSystem, placeFile)) !== record.placeHash
	) {
		return undefined;
	}

	return { hash: record.placeHash, path: placeFile, rebuilt: false };
}

async function reuseOrBuildPlaceAsync(
	options: PlaceArtifactOptions,
): Promise<BuildManifestArtifact & { rebuilt: boolean }> {
	const { fileSystem, placeFile, plan } = options;
	const reused =
		plan === undefined || options.forceRebuild === true
			? undefined
			: await tryReuseAsync({ fileSystem, placeFile, plan });
	return reused ?? stageAndBuildAsync(options);
}

async function planReuseAsync({
	fileSystem,
	projectFile,
	projectJson,
	reuse,
	stagingVersions,
}: {
	fileSystem: FileSystem;
	projectFile: string;
	projectJson: string;
	reuse: PlaceReuseOptions | undefined;
	stagingVersions: ReadonlyArray<number>;
}): Promise<ReusePlan | undefined> {
	if (reuse === undefined) {
		return undefined;
	}

	const { computeInputsKey = computePlaceInputsKeyAsync } = reuse;
	const inputsKey = await computeInputsKey({
		digestCacheFile: reuse.digestCacheFile,
		fileSystem,
		manifests: reuse.manifests ?? [],
		projectFile,
		projectJson,
		// Stryker disable next-line ArrayDeclaration: names no mount
		shadowRoots: reuse.shadowRoots ?? [],
		stagingVersions,
	});

	return inputsKey === undefined ? undefined : { cacheFile: reuse.cacheFile, inputsKey };
}
