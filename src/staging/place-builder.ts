import * as path from "node:path";
import { isDefined, pickBy } from "remeda";
import type { Except } from "type-fest";

import type { BuildManifestArtifact } from "../coverage-pipeline/build-manifest.ts";
import type { CoverageManifest } from "../coverage-pipeline/manifest.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { nodeChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { hashFileAsync } from "../utils/hash.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { buildWithRojoAsync } from "../utils/rojo-builder.ts";
import type { CodeBundleArtifact } from "./code-bundle.ts";
import { MAX_CODE_BUNDLE_BYTES, writeCodeBundle } from "./code-bundle.ts";
import { CODE_SPLIT_PASS_VERSION, splitCodeMounts } from "./code-split.ts";
import { demotePinnedMountsAsync, PINNED_MOUNT_PASS_VERSION } from "./pinned-mounts.ts";
import {
	computePlaceInputsKeyAsync,
	readPlaceReuseRecord,
	writePlaceReuseRecord,
} from "./place-reuse.ts";
import { relativizeProjectPaths } from "./relativize-paths.ts";
import { poolSharedMounts, SHARED_POOL_PASS_VERSION } from "./shared-pool.ts";
import type { PackageSynthesisInput, UnwrappedPackageSynthesisInput } from "./synthesizer-types.ts";
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

/** Where a build records its reuse key and what the key may skip walking. */
export interface PlaceReuseOptions {
	/** Where the previous build's key and place hash are recorded. */
	cacheFile: string;
	/** Computes the reuse key. Defaults to `computePlaceInputsKeyAsync`. */
	computeInputsKey?: typeof computePlaceInputsKeyAsync | undefined;
	/** Forwarded to `openInputDigestCache`, which says what it claims. */
	digestCacheFile: string;
	/**
	 * Coverage manifests standing in for a walk of the instrumented trees.
	 * Omit on a path no coverage run takes: every input is then walked off
	 * disk, which is what a build with nothing instrumented has to do anyway.
	 */
	manifests?: Array<CoverageManifest> | undefined;
	/** Shadow mounts the manifests cover, kept out of the walk. */
	shadowRoots?: Array<string> | undefined;
}

/** What a run needs to know about the Code Bundle a build wrote. */
export interface PlaceBuildResult extends BuildManifestArtifact {
	/**
	 * Present only when the caller asked for one, so the place is a harness.
	 */
	codeBundle?: CodeBundleArtifact;
}

/** Inputs to {@link buildPlaceAsync}. */
export type BuildPlaceOptions = BuildPlaceOptionsBase & PackageSynthesisInput;

/** {@link BuildPlaceOptions} for packages synthesized without a wrap. */
export type UnwrappedBuildPlaceOptions = BuildPlaceOptionsBase & UnwrappedPackageSynthesisInput;
/** Inputs to {@link buildCodeBundle}. */
export type BuildCodeBundleOptions = BuildCodeBundleOptionsBase & PackageSynthesisInput;

interface BuildPlaceOptionsBase {
	childProcess?: ChildProcessRunner;
	/**
	 * Build a Harness Place and write the Code Bundle beside it, rather than a
	 * place holding the run's code. Omit to build the whole place.
	 *
	 * The Code Roots: directories holding the code this run compiled. A mount
	 * inside one travels to the task in the bundle instead of riding into the
	 * session inside the place; everything else — `rbxts_include`, the vendored
	 * dependency tree, the game's own assets — stays in the Harness Place.
	 *
	 * Where the bundle lands is this module's to say rather than a caller's:
	 * it goes beside `placeFile`, so the two halves of one split cannot drift
	 * apart and no caller has to name a path to keep them together.
	 */
	codeRoots?: ReadonlyArray<PosixRoot> | undefined;
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
	placeFile: string;
	projectFile: string;
	/**
	 * Skip the rojo build when every input still hashes the same as the last
	 * one. Omit to always build — the callers that gate reuse upstream (multi's
	 * coverage path) would only be double-gating.
	 */
	reuse?: PlaceReuseOptions | undefined;
}

/**
 * {@link BuildPlaceOptions}, less everything only a place build needs.
 *
 * `placeFile` stays: nothing is built at it, but it is what says where the
 * bundle goes, and a bundle written anywhere else is one the reused place has
 * no relationship to.
 */
interface BuildCodeBundleOptionsBase extends Except<BuildPlaceOptionsBase, "codeRoots" | "reuse"> {
	codeRoots: ReadonlyArray<PosixRoot>;
}

/** What a split reads and where its two halves land, less the Code Roots. */
interface HarnessInput {
	fileSystem: FileSystem;
	placeFile: string;
	projectDirectory: string;
	projectJson: string;
}

/** The synthesized project and optional bundle prepared for a place build. */
interface PreparedPlaceProject {
	codeBundle: CodeBundleArtifact | undefined;
	projectDirectory: string;
	projectJson: string;
}

/** A cache file to consult, paired with the key its contents must match. */
interface ReusePlan {
	cacheFile: string;
	inputsKey: string;
}

/** Where the place goes, what it is built from, and what may excuse it. */
interface PlaceArtifactOptions {
	childProcess: ChildProcessRunner;
	fileSystem: FileSystem;
	placeFile: string;
	plan: ReusePlan | undefined;
	projectDirectory: string;
	projectFile: string;
	projectJson: string;
}

/**
 * Synthesize a rojo project for `packages`, write it to `projectFile`, build
 * the `.rbxl` at `placeFile`, and hash the result into a
 * `BuildManifestArtifact`. The single seam every place build routes through: a
 * Clean Place and a Coverage-Instrumented Place differ only in whether the
 * descriptors carry `coverageRoots`.
 * @param options - Packages, place and project paths, and optional split and reuse.
 * @returns The place path and hash, with the Code Bundle when one was written.
 * @rejects When the code is over the bundle cap, a buried pinned class is found, or rojo fails.
 */
export async function buildPlaceAsync(options: BuildPlaceOptions): Promise<PlaceBuildResult> {
	const {
		childProcess = nodeChildProcessRunner,
		contentId,
		fileSystem = nodeFileSystem,
		placeFile,
		projectFile,
		reuse,
	} = options;
	const { codeBundle, projectDirectory, projectJson } = preparePlaceProject(options, fileSystem);

	// Planned before anything is built, so a reused place pays for neither of
	// the two passes below — see `PlaceInputsKeyOptions.projectJson` for why a
	// key over the synthesized project can answer for what they write.
	const plan = await planReuseAsync({
		fileSystem,
		projectFile,
		projectJson: relativizeProjectPaths(projectJson, projectDirectory),
		reuse,
		stagingVersions: stagingVersionsFor(codeBundle !== undefined),
	});
	const artifact = await reuseOrBuildPlaceAsync({
		childProcess,
		fileSystem,
		placeFile,
		plan,
		projectDirectory,
		projectFile,
		projectJson,
	});
	return pickBy({ ...artifact, codeBundle, contentId }, isDefined);
}

/**
 * Write the Code Bundle for a run whose place is not being built.
 *
 * A caller that reused a place still has to send this run's code: the bundle is
 * read off disk every run, and a reused harness never held any of it. Same
 * split as {@link buildPlaceAsync} runs, over the same synthesized project, so
 * the two cannot disagree about which mounts travel — the harness project it
 * also produces is what a build would have used, and is dropped here.
 * @param options - Packages, Code Roots and the place the bundle sits beside.
 * @returns The written Code Bundle.
 * @throws When the bundle exceeds the Open Cloud cap.
 */
export function buildCodeBundle(options: BuildCodeBundleOptions): CodeBundleArtifact {
	const { codeRoots, fileSystem = nodeFileSystem, placeFile, projectFile } = options;
	return buildHarness({
		codeRoots,
		fileSystem,
		placeFile,
		projectDirectory: path.dirname(projectFile),
		projectJson: synthesize(options),
	}).bundle;
}

/**
 * The Harness Place's project, and the Code Bundle written beside it — or
 * nothing at all for a caller building the whole place.
 *
 * Both come out of one split, so the project that no longer mounts a path and
 * the bundle that now carries it can never disagree about which mounts those
 * were.
 * @param input - Synthesized project, its directory, the place file and Code Roots.
 * @returns The written bundle and the harness project text.
 * @throws When the bundle exceeds the Open Cloud cap.
 */
function buildHarness({
	codeRoots,
	fileSystem,
	placeFile,
	projectDirectory,
	projectJson,
}: HarnessInput & { codeRoots: ReadonlyArray<PosixRoot> }): {
	bundle: CodeBundleArtifact;
	projectJson: string;
} {
	const split = splitCodeMounts({ codeRoots, fileSystem, projectDirectory, projectJson });
	return {
		bundle: writeCodeBundle({
			fileSystem,
			maximumBytes: MAX_CODE_BUNDLE_BYTES,
			placeFile,
			split,
		}),
		projectJson: split.harnessProjectJson,
	};
}

function preparePlaceProject(
	options: BuildPlaceOptions,
	fileSystem: FileSystem,
): PreparedPlaceProject {
	const { codeRoots, placeFile, projectFile } = options;
	const projectDirectory = path.dirname(projectFile);
	const synthesized = synthesize(options);

	// Split first, so reuse sees the harness and a code-only edit can reuse it.
	// The bundle is still written because a reused harness never held this run's
	// code.
	const input: HarnessInput = {
		fileSystem,
		placeFile,
		projectDirectory,
		projectJson: synthesized,
	};
	const harness = codeRoots === undefined ? undefined : buildHarness({ ...input, codeRoots });

	return {
		codeBundle: harness?.bundle,
		projectDirectory,
		projectJson: harness?.projectJson ?? synthesized,
	};
}

/**
 * The pass versions this build's key folds.
 *
 * The split joins them only for a harness. It runs before the key rather than
 * after it, so the project text the key covers is already its output — but a
 * rule that changed which files the bundle carries out of a mount that travels
 * would move neither, and this is what stands for that half.
 * @param isHarness - Whether the build splits off a Code Bundle.
 * @returns The staging pass versions the key folds.
 */
function stagingVersionsFor(isHarness: boolean): ReadonlyArray<number> {
	return isHarness ? [...STAGING_PASS_VERSIONS, CODE_SPLIT_PASS_VERSION] : STAGING_PASS_VERSIONS;
}

/**
 * Write the project the build reads, build the place from it, and record the
 * key it was built under so the next run can reuse it.
 *
 * Relative `$path`s, written last: rojo matches `globIgnorePaths` against the
 * path as the project expresses it, so absolute ones would leave the ignore
 * list inert. The pinned-mount pass runs before it for the same reason — the
 * ignore entries it adds are expressed in that relative frame.
 *
 * The shared pool runs before the pinned-mount pass, so the pinned pass sees
 * one copy of each offending mount and builds one stand-in for it rather than
 * one per package.
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
}: PlaceArtifactOptions): Promise<BuildManifestArtifact> {
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
	// `rojo build -o` fails if the output directory is missing, so ensure it
	// exists for every caller rather than relying on each one to pre-create it.
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

	return { hash, path: placeFile };
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
 * @param options - The place file and the plan to check it against.
 * @param options.fileSystem - Reads the record and the place.
 * @param options.placeFile - Place from the previous build.
 * @param options.plan - Cache file and the key it must hold.
 * @returns The reused place's path and hash, or `undefined` to rebuild.
 */
async function tryReuseAsync({
	fileSystem,
	placeFile,
	plan,
}: {
	fileSystem: FileSystem;
	placeFile: string;
	plan: ReusePlan;
}): Promise<BuildManifestArtifact | undefined> {
	const record = readPlaceReuseRecord(plan.cacheFile, fileSystem);
	if (
		record?.inputsKey !== plan.inputsKey ||
		(await hashPlaceAsync(fileSystem, placeFile)) !== record.placeHash
	) {
		return undefined;
	}

	return { hash: record.placeHash, path: placeFile };
}

/**
 * The place this build answers with: the one already beside the plan's cache
 * file when its key still matches, and a freshly built one otherwise.
 *
 * The two are one decision rather than two steps, because a reuse that misses
 * has to build — so nothing between them can act on a place that is not there.
 * @param options - Project text, paths, adapters and the reuse plan.
 * @returns The reused or built place's path and hash.
 * @rejects When a build is needed and it fails.
 */
async function reuseOrBuildPlaceAsync(
	options: PlaceArtifactOptions,
): Promise<BuildManifestArtifact> {
	const { fileSystem, placeFile, plan } = options;
	const reused =
		plan === undefined ? undefined : await tryReuseAsync({ fileSystem, placeFile, plan });
	// Recorded as well as stamped, because the consumer that compares the two
	// reads its half off the artifact.
	return reused ?? stageAndBuildAsync(options);
}

/**
 * The cache file to consult and the key to match it against, or `undefined`
 * when this build has no cache to work with — reuse was not asked for, or the
 * inputs would not hash. Pairing the two means a caller never holds a key
 * without somewhere to put it.
 * @param options - The project, reuse options and pass versions to key.
 * @param options.fileSystem - Reads the inputs to hash.
 * @param options.projectFile - Path the project file is written to.
 * @param options.projectJson - Relativized project text the key covers.
 * @param options.reuse - Reuse options, or `undefined` when reuse is off.
 * @param options.stagingVersions - Pass versions folded into the key.
 * @returns The plan, or `undefined` without reuse or a key.
 */
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
		// The path rewrite is not among them: it is already applied to the text
		// this key is computed over, so a change to that rule moves the key on
		// its own.
		stagingVersions,
	});

	return inputsKey === undefined ? undefined : { cacheFile: reuse.cacheFile, inputsKey };
}
