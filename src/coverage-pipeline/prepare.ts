import * as path from "node:path";

import type { ResolvedConfig } from "../config/schema.ts";
import type { TsconfigReader } from "../executor/tsconfig-mappings.ts";
import { nodeTsconfigReader } from "../executor/tsconfig-mappings.ts";
import type { CoverageRoot } from "../staging/synthesizer-types.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import { NOOP_TIMING_COLLECTOR } from "../timing/orchestration-collector.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { nodeChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { BuildManifestProject, CoverageArtifacts } from "./build-manifest.ts";
import { BUILD_MANIFEST_FILE } from "./build-manifest.ts";
import { bakeCoveragePlaceAsync } from "./coverage-place.ts";
import { createCopyIgnoreMatcher, hashCopyIgnorePatterns } from "./discover-files.ts";
import { canReuseCoverageManifest } from "./incremental-gate.ts";
import type { InstrumentUniverse } from "./instrument-universe.ts";
import { createInstrumentUniverse } from "./instrument-universe.ts";
import type { Instrumenter } from "./instrumenter.ts";
import { nodeInstrumenter } from "./instrumenter.ts";
import { findRojoProject, narrowConfiguredRoots } from "./luau-roots.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
} from "./manifest.ts";
import { SHADOW_DIR } from "./place-build.ts";
import type { CoverageInputs, PrepareCoverageResult, ShadowRootsResult } from "./prepare-types.ts";
import { loadPriorManifest } from "./prior-manifest.ts";
import { tryComputeRojoInputsHashAsync } from "./rojo-inputs.ts";
import type { BakeOwnershipMatcher } from "./shadow-reconcile.ts";
import type { ShadowRootResult } from "./shadow-root.ts";
import { prepareShadowRoot } from "./shadow-root.ts";
import type { PreparedSpine, ShadowBake } from "./spine.ts";
import { prepareSpine } from "./spine.ts";

/** Framed on `rootDir`, and outside the directory a cold rebuild wipes. */
const INPUT_DIGEST_PATH = ".jest-roblox/input-digests";
const COVERAGE_MANIFEST = "coverage-manifest.json";

/** Where the coverage path publishes its sibling manifests (cwd-relative). */
export const COVERAGE_MANIFEST_PATH: string = path.join(SHADOW_DIR, COVERAGE_MANIFEST);
export const COVERAGE_BUILD_MANIFEST_PATH: string = path.join(SHADOW_DIR, BUILD_MANIFEST_FILE);

/** Injectable seams and run inputs for {@link prepareCoverageAsync}. */
export interface PrepareCoverageOptions {
	/** What this run writes into the shadow before the place is built. */
	bake?: ShadowBake | undefined;
	/**
	 * What launches rojo for the place build. Defaults to the real launcher.
	 */
	childProcess?: ChildProcessRunner;
	/**
	 * Build a Harness Place: split the mounts inside these Code Roots out of
	 * the project and write them beside the place as a Code Bundle instead.
	 * Omit to build the whole place.
	 */
	codeRoots?: ReadonlyArray<PosixRoot> | undefined;
	/**
	 * The run's effective coverage include globs, per `resolveCoverageInclude`
	 * — which is where the fallback from `collectCoverageFrom` to derived globs
	 * lives. A caller that omits it gets the raw config value, so a run that
	 * never resolves the fallback still narrows by anything explicitly set.
	 */
	coverageInclude?: Array<string> | undefined;
	/** Where the shadow is built. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/** What writes the instrumented twins. Defaults to the real one. */
	instrumenter?: Instrumenter | undefined;
	/** Universe to instrument; resolved from the config when omitted. */
	instrumentUniverse?: InstrumentUniverse | undefined;
	/**
	 * The run's collector, so the two phases this call reports nest under the
	 * `prepareCoverage` span the caller opened around it. Omitted by the
	 * offline build path, which has no run to profile; both phases are still
	 * measured, since their durations feed a Duration line either way.
	 */
	timing?: TimingCollector | undefined;
	/** How a tsconfig is read. Defaults to the real one. */
	tsconfigReader?: TsconfigReader | undefined;
}

interface ShadowPassSettings {
	instrumenter: Instrumenter;
	isBakeOwned: BakeOwnershipMatcher | undefined;
	isIncremental: boolean;
}

interface CoverageInputSources {
	config: ResolvedConfig;
	coverageInclude: Array<string> | undefined;
	fileSystem: FileSystem;
	instrumentUniverse: InstrumentUniverse | undefined;
	tsconfigReader: TsconfigReader;
}

/**
 * Project the coverage result down to the record an entry point emits.
 * @param result - Prepared coverage.
 * @param projects - Projects the build manifest lists.
 * @returns Coverage artifacts record.
 */
export function toCoverageArtifacts(
	result: PrepareCoverageResult,
	projects: Array<BuildManifestProject>,
): CoverageArtifacts {
	return {
		buildId: result.buildId,
		coveragePlace: result.coveragePlace,
		files: result.files,
		generatedAt: result.manifest.generatedAt,
		projects,
		rebuilt: result.rebuilt,
	};
}

/**
 * Instrument the configured Luau roots into the shadow and bake or reuse the
 * coverage place.
 * @param config - Resolved run config.
 * @param options - Injectable seams and run inputs.
 * @returns The place, manifest and timings for the instrument and staging
 *   phases.
 */
export async function prepareCoverageAsync(
	config: ResolvedConfig,
	{
		bake,
		childProcess = nodeChildProcessRunner,
		codeRoots,
		coverageInclude,
		fileSystem = nodeFileSystem,
		instrumenter = nodeInstrumenter,
		instrumentUniverse,
		timing = NOOP_TIMING_COLLECTOR,
		tsconfigReader = nodeTsconfigReader,
	}: PrepareCoverageOptions = {},
): Promise<PrepareCoverageResult> {
	const { elapsedMs: instrumentMs, value: instrumented } = await timing.profileTimedAsync(
		"instrumentSources",
		async () => {
			const inputs = await resolveCoverageInputsAsync({
				config,
				coverageInclude,
				fileSystem,
				instrumentUniverse,
				tsconfigReader,
			});
			const isIncremental = decideIncremental(config, inputs);
			const pass = { instrumenter, isBakeOwned: bake?.isBakeOwned, isIncremental };
			return { inputs, isIncremental, shadow: prepareShadowRoots(inputs, pass) };
		},
	);

	// Coverage pays for the instrumentation and nothing else. The other phase is
	// the place build and the gate deciding whether to do it — the bake writes
	// stubs into the shadow tree, and the reuse gate re-hashes the cached
	// place. Both are staging: a non-coverage run pays the same work.
	const { elapsedMs: stagingMs, value: baked } = await timing.profileTimedAsync(
		"bakeCoveragePlace",
		async () => bakeCoveragePlaceAsync({ bake, childProcess, codeRoots, config, instrumented }),
	);

	return { ...baked, instrumentMs, stagingMs };
}

/**
 * Hash the rojo build inputs the per-luauRoot shadow diff never sees
 * (include/, vendored @rbxts, assets, the project files). Runs regardless of
 * how luauRoots resolved. A malformed/circular project throws; degrade to
 * `undefined` so the caller skips the inputs check (a project too broken
 * to hash would also fail the rebuild's own parse) rather than hard-failing a
 * working run.
 * @param options - Config, file system, luau roots and rojo project path.
 * @returns Input hash, or undefined when it cannot be computed.
 */
async function resolveRojoInputsHashAsync({
	config,
	fileSystem,
	luauRoots,
	rojoProjectPath,
}: {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	luauRoots: Array<string>;
	rojoProjectPath: string;
}): Promise<string | undefined> {
	return tryComputeRojoInputsHashAsync({
		digestCacheFile: path.join(config.rootDir, INPUT_DIGEST_PATH),
		fileSystem,
		luauRoots,
		rojoProjectPath,
		rootDirectory: config.rootDir,
	});
}

/**
 * The run's instrument-time universe.
 *
 * No `rootDir`: the candidate paths these globs are matched against are
 * cwd-relative here. `luauRoots` are walked from the invocation directory and
 * `SHADOW_DIR` hangs off it, so the manifest keys — and through them the
 * mapped TS paths — are cwd-relative too. Anchoring the globs anywhere else
 * would match none of them. Only workspace mode, whose candidates are absolute
 * under a package, has an anchor worth preferring.
 * @param options - Config, include globs and file system.
 * @returns The universe, or undefined when the globs do not narrow.
 */
function resolveUniverse({
	config,
	coverageInclude,
	fileSystem,
}: {
	config: ResolvedConfig;
	coverageInclude: Array<string> | undefined;
	fileSystem: FileSystem;
}): InstrumentUniverse | undefined {
	return createInstrumentUniverse(
		{
			ignore: config.coveragePathIgnorePatterns,
			include: coverageInclude ?? config.collectCoverageFrom,
		},
		fileSystem,
	);
}

function loadCoverageManifest(fileSystem: FileSystem): CoverageManifest | undefined {
	return loadPriorManifest({
		fileSystem,
		label: "Previous coverage manifest",
		manifestPath: COVERAGE_MANIFEST_PATH,
	});
}

/**
 * Resolve the rojo project, the luau roots, the non-luauRoot inputs hash and
 * the prior manifest — everything the rest of the run reads but never mutates.
 * @param options - Config, include globs, file system, universe and tsconfig
 *   reader.
 * @returns Coverage inputs for the run.
 */
async function resolveCoverageInputsAsync({
	config,
	coverageInclude,
	fileSystem,
	instrumentUniverse,
	tsconfigReader,
}: CoverageInputSources): Promise<CoverageInputs> {
	const rojoProjectPath = findRojoProject(config, fileSystem);
	const isCopyIgnored = createCopyIgnoreMatcher(config.coverageCopyIgnorePatterns);
	const universe = instrumentUniverse ?? resolveUniverse({ config, coverageInclude, fileSystem });
	const rootSources = {
		config,
		fileSystem,
		isCopyIgnored,
		rojoProjectPath,
		tsconfigReader,
		universe,
	};
	const narrowed = narrowConfiguredRoots(rootSources);
	const luauRoots = narrowed.flatMap((entry) => entry.roots);
	const hash = await resolveRojoInputsHashAsync({ ...rootSources, luauRoots });

	return {
		buildManifestPath: path.join(SHADOW_DIR, BUILD_MANIFEST_FILE),
		copyIgnoreHash: hashCopyIgnorePatterns(config.coverageCopyIgnorePatterns),
		fileSystem,
		isCopyIgnored,
		luauRoots,
		manifestPath: COVERAGE_MANIFEST_PATH,
		narrowed,
		previousManifest: loadCoverageManifest(fileSystem),
		rojoInputsHash: hash,
		rojoProjectPath,
		universe,
	};
}

function hasDroppedLuauRoot(previous: Array<string>, current: Array<string>): boolean {
	const currentSet = new Set(current.map(normalizeWindowsPath));
	return previous.some((root) => !currentSet.has(normalizeWindowsPath(root)));
}

/**
 * Decide whether the cached shadow dirs can be reused, wiping the coverage dir
 * when they can't so a cold run starts from nothing.
 * @param config - Resolved run config.
 * @param inputs - Coverage inputs holding the prior manifest.
 * @returns True when the shadow may be reused.
 */
function decideIncremental(
	config: ResolvedConfig,
	{ copyIgnoreHash, fileSystem, luauRoots, previousManifest, universe }: CoverageInputs,
): boolean {
	// A dropped luauRoot is invisible to the per-root reconcile — it only walks
	// the current roots — so the dropped root's instrumented shadow subtree and
	// its stale manifest entries would survive a reuse. Force a cold rebuild so
	// the rmSync below wipes them. An *added* root needs no cold rebuild: the
	// existing roots stay cached and the new one is instrumented normally.
	const isIncremental =
		canReuseCoverageManifest(previousManifest, {
			copyIgnoreHash,
			coverageCache: config.coverageCache,
			universe,
		}) && !hasDroppedLuauRoot(previousManifest.luauRoots, luauRoots);

	if (!isIncremental && fileSystem.existsSync(SHADOW_DIR)) {
		fileSystem.rmSync(SHADOW_DIR, { recursive: true });
	}

	return isIncremental;
}

/**
 * One narrowed root, instrumented into the shadow directory that mirrors it.
 * @param inputs - Coverage inputs.
 * @param pass - Instrumenter, bake ownership, incremental flag and root.
 * @returns The root's shadow result.
 */
function instrumentOneRoot(
	{ fileSystem, isCopyIgnored, previousManifest, universe }: CoverageInputs,
	{
		instrumenter,
		isBakeOwned,
		isIncremental,
		luauRoot,
	}: ShadowPassSettings & { luauRoot: PosixRoot },
): ShadowRootResult {
	return prepareShadowRoot({
		fileSystem,
		instrumenter,
		isBakeOwned,
		isCopyIgnored,
		luauRoot,
		previousManifest,
		shadowDir: normalizeWindowsPath(path.join(SHADOW_DIR, luauRoot)),
		universe,
		useIncremental: isIncremental,
	});
}

/**
 * The spine pass for single mode. The narrowed paths here are already the
 * source's own — this mode walks them from the invocation directory — so a
 * spine level names its own directory.
 * @param inputs - Coverage inputs.
 * @param pass - Shadow pass settings.
 * @returns The prepared spine.
 */
function prepareSingleSpine(
	inputs: CoverageInputs,
	{ isBakeOwned }: ShadowPassSettings,
): PreparedSpine {
	return prepareSpine({
		fileSystem: inputs.fileSystem,
		isBakeOwned,
		isCopyIgnored: inputs.isCopyIgnored,
		narrowed: inputs.narrowed,
		previousNonInstrumented: inputs.previousManifest?.nonInstrumentedFiles,
		shadowRoot: SHADOW_DIR,
		toSourcePath: (relativePath) => relativePath,
	});
}

/**
 * Instrument every luauRoot into its shadow dir and merge the results.
 * @param inputs - Coverage inputs.
 * @param pass - Shadow pass settings.
 * @returns Merged shadow result over all roots.
 */
function prepareShadowRoots(inputs: CoverageInputs, pass: ShadowPassSettings): ShadowRootsResult {
	const files: Record<string, InstrumentedFileRecord> = {};
	const coverageRoots: Array<CoverageRoot> = [];
	const spine = prepareSingleSpine(inputs, pass);
	const nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord> = { ...spine.files };
	let hasChanges = spine.changed;

	for (const luauRoot of inputs.luauRoots) {
		const result = instrumentOneRoot(inputs, { ...pass, luauRoot });
		hasChanges ||= result.changed;
		Object.assign(files, result.files);
		Object.assign(nonInstrumentedFiles, result.nonInstrumentedFiles);
		coverageRoots.push({
			luauRoot: result.luauRoot,
			shadowDir: normalizeWindowsPath(path.resolve(result.shadowDir)),
		});
	}

	return {
		changed: hasChanges,
		coverageRoots,
		coverageSpine: spine.directories,
		files,
		nonInstrumentedFiles,
	};
}
