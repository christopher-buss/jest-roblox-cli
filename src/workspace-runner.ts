import { collectPaths, loadRojoProject, rebaseTreePaths } from "@isentinel/rojo-utils";

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import type { Backend, StreamingHooks } from "./backends/interface.ts";
import { applyExcludes } from "./config/apply-excludes.ts";
import { deriveTypecheckInclude } from "./config/derive-typecheck-include.ts";
import { loadConfig } from "./config/loader.ts";
import { mergeCliWithConfig } from "./config/merge.ts";
import { narrowForLuauRun } from "./config/narrow-by-files.ts";
import type { ResolvedProjectConfig } from "./config/projects.ts";
import { createFsClassifier, resolveAllProjects } from "./config/projects.ts";
import type {
	ResolvedTypecheckConfig,
	TypecheckCliOptions,
} from "./config/resolve-typecheck-config.ts";
import { resolveTypecheckConfig } from "./config/resolve-typecheck-config.ts";
import type {
	CliOptions,
	InlineProjectConfig,
	ProjectEntry,
	ResolvedConfig,
	WorkspaceRunOptions,
} from "./config/schema.ts";
import { DEFAULT_CONFIG } from "./config/schema.ts";
import { createSetupResolver } from "./config/setup-resolver.ts";
import {
	cleanLeftoverStubs,
	generateProjectStubs,
	hasUserAuthoredConfig,
	STUB_FILENAME,
} from "./config/stubs.ts";
import type { CoverageManifest } from "./coverage/manifest.ts";
import {
	emitWorkspaceBuildManifests,
	prepareWorkspaceCoverage,
	type WorkspacePackageCoverage,
} from "./coverage/workspace-prepare.ts";
import { type ExecuteResult, runProjects, type RunProjectsOptions } from "./executor.ts";
import { writeJsonFile } from "./formatters/json.ts";
import { usesAgentFormatter } from "./formatters/utils.ts";
import { StreamingResultClient } from "./memory-store/sorted-map-client.ts";
import { prepareWorkStealingQueue } from "./memory-store/work-stealing.ts";
import { mergeProjectResults, mergeResults } from "./output.ts";
import {
	StreamingAggregator,
	type StreamingAggregatorOnEntry,
} from "./reporter/streaming-aggregator.ts";
import { classifyTestFiles, discoverTestFiles } from "./run/discovery.ts";
import { buildPlace } from "./staging/place-builder.ts";
import type { PackageDescriptor, StubMount } from "./staging/synthesizer.ts";
import {
	generateMaterializerScript,
	generateWorkStealingScript,
	type MaterializerInput,
} from "./staging/test-script-staged.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "./timing/orchestration-collector.ts";
import type { TypecheckGroupEntry, TypecheckPassOutcome } from "./typecheck/group-by-tsconfig.ts";
import { runTypecheckPass } from "./typecheck/group-by-tsconfig.ts";
import { runTypecheck } from "./typecheck/runner.ts";
import type { JestResult } from "./types/jest-result.ts";
import type { RojoTreeNode } from "./types/rojo.ts";
import {
	buildGroupedGameOutput,
	countGroupedEntries,
	formatGameOutputNotice,
	parseGameOutput,
	writeGameOutput,
	writeGroupedGameOutput,
} from "./utils/game-output.ts";
import { globSync } from "./utils/glob.ts";
import { ensurePackageDirectories } from "./workspace/ensure-paths.ts";
import type { PackageInfo } from "./workspace/package-resolver.ts";
import { type PreflightError, validatePackages } from "./workspace/preflight.ts";

const SYNTHESIZED_PROJECT_FILE = "synthesized.project.json";
const SYNTHESIZED_PLACE_FILE = "synthesized.rbxl";
const WORKSPACE_CACHE_DIRECTORY = path.join(".jest-roblox", "workspace");
const ROJO_PROJECT_DEFAULT = "test.project.json";

export interface RunWorkspaceOptions {
	/**
	 * Open Cloud backend for the runtime dispatch. Optional: `--typecheckOnly`
	 * runs pure-local tsgo and short-circuits before any dispatch, so the caller
	 * omits the backend (and its credentials) entirely for type-only runs.
	 */
	backend?: Backend;
	cli: CliOptions;
	/**
	 * When provided, called once per newly-observed streaming result as
	 * packages complete (work-stealing mode only). The intended consumer is
	 * the human formatter, which uses this hook to flush per-package output
	 * to stdout as it lands. Omit for buffering formatters (JSON) so the
	 * final envelope is built once at task end.
	 */
	onStreamingResult?: StreamingAggregatorOnEntry;
	packageInfos: Array<PackageInfo>;
	/**
	 * Per-invocation knobs resolved by `buildWorkspaceRunOptions` —
	 * CLI > per-package consensus > defaults. The workspace runner does
	 * NOT read jest-shaped fields here; per-package config (loaded inside
	 * `loadPackages`) is the source of truth for those.
	 */
	runOptions: WorkspaceRunOptions;
	/**
	 * Span-tree profiler created at the top of `runJestRoblox`. The
	 * workspace runner does NOT flush — the caller owns the lifecycle so a
	 * single `[TIMING]` waterfall covers the whole invocation rather than
	 * emitting a half-tree if a downstream phase throws. Optional so direct
	 * test seams keep working; production callers always pass one.
	 */
	timing?: TimingCollector;
	version: string;
	workspaceRoot: string;
	/**
	 * Credentials used to coordinate work-stealing across parallel OCALE
	 * tasks via a memory-store queue. When provided alongside
	 * `cli.parallel > 1`, the workspace runner pushes every (pkg, project)
	 * onto a per-run UUID queue and the backend fires N tasks all running
	 * the same materializer script. Without it (or with parallel=1) the
	 * runner uses the existing single-task embedded-entries path.
	 */
	workStealingCredentials?: { apiKey: string; baseUrl?: string; universeId: string };
}

export interface WorkspaceProjectResult {
	/**
	 * When coverage is enabled in workspace mode, the per-package manifest
	 * captured during `prepareWorkspaceCoverage`. Downstream aggregation maps
	 * the result's `coverageData` (raw hit counts captured by the materializer)
	 * back through this manifest to produce TS-coord Istanbul records.
	 */
	coverageManifest?: CoverageManifest;
	displayName: string;
	pkg: string;
	result: ExecuteResult;
}

/**
 * What `runWorkspace` returns: the per-(package, project) runtime `results` plus
 * the merged host-side Type Test result (set only when `test.typecheck`
 * discovered any). `--typecheckOnly` returns empty `results` still carrying
 * `typecheckResult`. `undefined` (not this shape) signals a preflight/empty-package
 * failure.
 */
export interface WorkspaceRunnerOutput {
	results: Array<WorkspaceProjectResult>;
	typecheckResult?: JestResult;
}

interface PackageContext {
	cacheRoot: string;
	descriptor: PackageDescriptor;
	info: PackageInfo;
	pkgConfig: ResolvedConfig;
	projects: Array<ResolvedProjectConfig>;
}

interface LoadedPackage {
	descriptor: PackageDescriptor;
	info: PackageInfo;
	pkgConfig: ResolvedConfig;
}

interface PendingEntry {
	pkg: string;
	project: ResolvedProjectConfig;
	projectConfig: ResolvedConfig;
	testFiles: Array<string>;
}

/**
 * Per-package Type Test reporting/runner policy, keyed by the package directory
 * (each group's `cwd`). `ignoreSourceErrors`/`spawnTimeout` are package-wide —
 * the workspace analogue of multi's run-wide root policy — while the per-project
 * tsconfig (carried on the {@link TypecheckGroupEntry}) drives grouping. `pkg`
 * composes package identity onto each merged file result.
 */
interface PackageTypecheck {
	ignoreSourceErrors?: boolean;
	pkg: string;
	spawnTimeout?: number;
}

// A (package, project) pair that owns Type Tests. The type pass groups by
// `(cwd, tsconfig)` and reports per package, so this records the project names a
// package's type result is written under in the per-package result files.
interface TypeTestProject {
	pkg: string;
	project: string;
}

interface DiscoveredTests {
	pending: Array<PendingEntry>;
	typecheckByDirectory: Map<string, PackageTypecheck>;
	typeTestEntries: Array<TypecheckGroupEntry>;
	typeTestProjects: Array<TypeTestProject>;
}

type WorkspaceDispatchSpec = Pick<
	RunProjectsOptions,
	"parallel" | "scriptOverride" | "streaming" | "workStealing"
>;

export async function runWorkspace(
	options: RunWorkspaceOptions,
): Promise<undefined | WorkspaceRunnerOutput> {
	return runWorkspaceProfiled(options, options.timing ?? NOOP_TIMING_COLLECTOR);
}

function buildCoverageMap(
	entries: Array<WorkspacePackageCoverage>,
): Map<string, WorkspacePackageCoverage> {
	const map = new Map<string, WorkspacePackageCoverage>();
	for (const entry of entries) {
		map.set(entry.pkg, entry);
	}

	return map;
}

async function runWorkspaceProfiled(
	options: RunWorkspaceOptions,
	timing: TimingCollector,
): Promise<undefined | WorkspaceRunnerOutput> {
	const { backend, cli, packageInfos, version, workspaceRoot } = options;
	const startTime = Date.now();

	// Load each package's config FIRST so that per-package `rojoProject`
	// declarations override the workspace default. Building the descriptor
	// (and the path preflight uses) before loadConfig pinned every package
	// to the parent's rojo file.
	const loaded = await timing.profileAsync("loadPackages", async () => {
		return loadPackages({ cli, packageInfos, timing });
	});

	ensurePackageDirectories(loaded.map((entry) => entry.descriptor));

	const errors = validatePackages(loaded.map((entry) => entry.descriptor));
	if (errors.length > 0) {
		writePreflightErrors(errors);
		return undefined;
	}

	const cacheDirectory = path.join(workspaceRoot, WORKSPACE_CACHE_DIRECTORY);
	fs.mkdirSync(cacheDirectory, { recursive: true });

	const contexts = await timing.profileAsync("resolveContexts", async () => {
		return resolvePackageContexts({ cacheDirectory, loaded });
	});

	// Each package decides independently. A package with zero discovered
	// tests passes only when its OWN `passWithNoTests` is true; the
	// workspace root's value is not aggregated over packages. Projects with
	// zero tests inside a populated package are silently dropped.
	const {
		emptyPackageErrors,
		filteredContexts,
		pending,
		typecheckByDirectory,
		typeTestEntries,
		typeTestProjects,
	} = timing.profile("discoverTests", () => {
		const discoveredContexts = applyProjectFilter(contexts, cli.project);
		const discovered = collectPendingEntries(discoveredContexts, cli);
		const typeTestPackages = new Set(
			[...discovered.typecheckByDirectory.values()].map((entry) => entry.pkg),
		);
		const policy = applyEmptyPackagePolicy(
			discovered.pending,
			discoveredContexts,
			typeTestPackages,
		);
		return {
			emptyPackageErrors: policy.emptyPackageErrors,
			filteredContexts: discoveredContexts,
			pending: policy.pending,
			typecheckByDirectory: discovered.typecheckByDirectory,
			typeTestEntries: discovered.typeTestEntries,
			typeTestProjects: discovered.typeTestProjects,
		};
	});
	if (emptyPackageErrors.length > 0) {
		for (const error of emptyPackageErrors) {
			process.stderr.write(`${error}\n`);
		}

		return undefined;
	}

	if (pending.length === 0) {
		// No runtime jobs. With Type Tests present (`--typecheckOnly`, or
		// type-test-only packages), skip instrumentation, the synthesized place
		// build, and Open Cloud dispatch entirely — run only the host-side type
		// pass and return it. Without Type Tests, nothing to test.
		if (typeTestEntries.length === 0) {
			return { results: [] };
		}

		return runTypecheckOnlyWorkspace({
			runOptions: options.runOptions,
			timing,
			typecheckByDirectory,
			typeTestEntries,
			typeTestProjects,
			workspaceRoot,
		});
	}

	// Limit instrumentation to packages that actually have pending tests
	// AND opted into coverage via their own config. Per-package opt-in
	// matches passWithNoTests: the workspace root's value is not
	// aggregated over packages. Instrumenting packages that won't run
	// (or didn't ask for coverage) wastes time on every run
	// (instrumentation is the dominant pre-OCALE cost).
	const pendingPackageNames = new Set(pending.map((entry) => entry.pkg));
	const coverageOptIn = new Set(
		filteredContexts.filter((ctx) => ctx.pkgConfig.collectCoverage).map((ctx) => ctx.info.name),
	);
	const coveragePackages = loaded
		.map((entry) => entry.descriptor)
		.filter(
			(descriptor) =>
				pendingPackageNames.has(descriptor.name) && coverageOptIn.has(descriptor.name),
		);
	const coverageByPackage =
		coveragePackages.length > 0
			? timing.profile("prepareCoverage", () => {
					return buildCoverageMap(
						prepareWorkspaceCoverage({
							packages: coveragePackages,
							timing,
							workspaceRoot,
						}),
					);
				})
			: new Map<string, WorkspacePackageCoverage>();

	const liveProjects = liveProjectsByPackage(pending);

	// Pre-flight cleanup: walks live projects' known mount paths in each
	// package source tree and removes marker-bearing leftover stubs from
	// pre-refactor multi-project runs. Without this, the synthesizer's
	// `assertNoSourceCollision` would reject them and re-trigger the
	// original cross-mode bug this refactor exists to fix.
	for (const ctx of filteredContexts) {
		const live = liveProjects.get(ctx.info.name) ?? new Set<string>();
		const liveProjectsForPackage = ctx.projects.filter((project) =>
			live.has(project.displayName),
		);
		const cleaned = cleanLeftoverStubs(liveProjectsForPackage, ctx.info.packageDirectory);
		if (cleaned.length > 0) {
			process.stderr.write(
				`jest-roblox: cleaned ${String(cleaned.length)} leftover stub(s) from ${ctx.info.name}:\n${cleaned
					.map((stubPath) => `  ${stubPath}\n`)
					.join("")}`,
			);
		}
	}

	const descriptorsWithStubs = timing
		.profile("buildStubs", () => writeStubsAndBuildDescriptors(filteredContexts, liveProjects))
		.map((descriptor) => {
			const coverage = coverageByPackage.get(descriptor.name);
			return coverage !== undefined
				? { ...descriptor, coverageRoots: coverage.coverageRoots }
				: descriptor;
		});

	const synthProjectPath = path.join(cacheDirectory, SYNTHESIZED_PROJECT_FILE);
	const synthRbxlPath = path.join(cacheDirectory, SYNTHESIZED_PLACE_FILE);

	const coveragePlace = timing.profile("rojoBuild", () => {
		return buildPlace({
			packages: descriptorsWithStubs,
			placeFile: synthRbxlPath,
			projectFile: synthProjectPath,
		});
	});

	// Emit only after the shared build succeeds: `buildPlace` throws on a failed
	// rojo build, so a per-package Build Manifest never points at a place that
	// isn't on disk. Every coverage package records the one shared instrumented
	// place as its coverage place.
	if (coverageByPackage.size > 0) {
		emitWorkspaceBuildManifests([...coverageByPackage.values()], coveragePlace);
	}

	const inputs: Array<MaterializerInput> = pending.map((entry) => {
		return {
			config: { ...entry.projectConfig, placeFile: synthRbxlPath },
			pkg: entry.pkg,
			project: entry.project.displayName,
			testFiles: entry.testFiles,
		};
	});

	const { onStreamingResult, runOptions, workStealingCredentials } = options;
	const dispatchSpec = await timing.profileAsync("prepareDispatch", async () => {
		return prepareWorkspaceDispatch({
			inputs,
			...(onStreamingResult !== undefined ? { onStreamingResult } : {}),
			parallel: runOptions.parallel,
			workStealingCredentials,
		});
	});

	// The grouped tsgo pass depends only on the filesystem (discovery already
	// ran), so it overlaps the network-bound Open Cloud upload/poll. Await both,
	// then record the tsgo span — the collector's LIFO stack is not
	// concurrency-safe, so the pass times itself and the span lands after the
	// barrier (same caveat as single/multi).
	const [{ results }, typecheckPass] = await Promise.all([
		timing.profileAsync("runProjects", async () => {
			return runProjects({
				// Defined whenever runtime jobs exist: only `--typecheckOnly`
				// omits the backend, and that path short-circuits above before
				// reaching any runtime dispatch.
				// eslint-disable-next-line ts/no-non-null-assertion -- backend present for runtime jobs
				backend: backend!,
				deferFormatting: true,
				projects: pending.map((entry) => {
					return {
						config: { ...entry.projectConfig, placeFile: synthRbxlPath },
						displayColor: entry.project.displayColor,
						displayName: entry.project.displayName,
						pkg: entry.pkg,
						testFiles: entry.testFiles,
					};
				}),
				startTime,
				timing,
				version,
				...dispatchSpec,
			});
		}),
		runWorkspaceTypecheckPass(typeTestEntries, typecheckByDirectory),
	]);

	if (runOptions.workspaceOutputFile) {
		writePerPackageOutputFiles(
			workspaceRoot,
			buildPerPackageResults(pending, results, typecheckPass.byPackage, typeTestProjects),
		);
	}

	if (runOptions.outputFile !== undefined) {
		await writeWorkspaceOutputFile(
			runOptions.outputFile,
			mergeProjectResults(results).result,
			typecheckPass.outcome.result,
		);
	}

	emitWorkspaceGameOutput({
		pending,
		results,
		runOptions,
		verbose: options.cli.verbose,
		workspaceRoot,
	});

	return attachTypecheck(
		attachCoverageManifests(results, pending, coverageByPackage),
		typecheckPass.outcome,
		timing,
	);
}

const PER_PACKAGE_TIMEOUT_SECONDS = 60;

// The workspace per-package variant of {@link runTypecheckPass}: each group's
// package-wide `ignoreSourceErrors`/`spawnTimeout` come from
// `typecheckByDirectory` (keyed by `cwd = package`), and `composePackageIdentity`
// stamps the package name onto every file result so two packages'
// identically-named `-d` files stay distinct after the merge.
// Outcome of the workspace Type Test pass: the aggregate `outcome` (the merged
// result + timing the existing sinks consume) plus `byPackage`, the merged Type
// Test result keyed by package name. The per-package result files write each
// package's result under every project that owns Type Tests, so they need the
// split the aggregate has already collapsed.
interface WorkspaceTypecheckPass {
	byPackage: Map<string, JestResult>;
	outcome: TypecheckPassOutcome;
}

function buildStreaming(input: {
	credentials: { apiKey: string; baseUrl?: string; universeId: string };
	generateUuid: () => string;
	onStreamingResult: StreamingAggregatorOnEntry;
}): { hooks: StreamingHooks; sortedMapId: string } {
	const sortedMapId = input.generateUuid();
	// drain() is intentionally untouched in the current production path —
	// it's an in-memory buffer kept for future formatter integrations that
	// need to emit a final summary across all streamed entries (e.g. JSON
	// envelope with per-pkg summaries). Today the aggregator's sole job is
	// per-arrival dedupe + forwarding to onStreamingResult.
	const aggregator = new StreamingAggregator({ onEntry: input.onStreamingResult });
	const reader = new StreamingResultClient({
		...(input.credentials.baseUrl !== undefined ? { baseUrl: input.credentials.baseUrl } : {}),
		credentials: {
			apiKey: input.credentials.apiKey,
			universeId: input.credentials.universeId,
		},
		mapId: sortedMapId,
	});

	return {
		hooks: {
			onPackageResult: (entry) => {
				aggregator.accept(entry);
			},
			reader,
		},
		sortedMapId,
	};
}

async function prepareWorkspaceDispatch(input: {
	generateUuid?: () => string;
	inputs: Array<MaterializerInput>;
	onStreamingResult?: StreamingAggregatorOnEntry;
	parallel?: "auto" | number;
	workStealingCredentials: undefined | { apiKey: string; baseUrl?: string; universeId: string };
}): Promise<WorkspaceDispatchSpec> {
	const { generateUuid, inputs, onStreamingResult, workStealingCredentials } = input;

	// `runOptions.parallel` already reflects CLI > per-package consensus >
	// default; `"auto"` does not enable work-stealing (parity with the
	// pre-existing CLI behavior — only an explicit count > 1 fans out).
	const parallel = typeof input.parallel === "number" ? input.parallel : undefined;
	const useWorkStealing =
		workStealingCredentials !== undefined && parallel !== undefined && parallel > 1;

	if (useWorkStealing) {
		const prepared = await prepareWorkStealingQueue({
			...(workStealingCredentials.baseUrl !== undefined
				? { baseUrl: workStealingCredentials.baseUrl }
				: {}),
			credentials: {
				apiKey: workStealingCredentials.apiKey,
				universeId: workStealingCredentials.universeId,
			},
			packages: inputs.map((entry) => ({ pkg: entry.pkg, project: entry.project })),
			perPackageTimeoutSeconds: PER_PACKAGE_TIMEOUT_SECONDS,
		});

		// Gate streaming setup on an actual consumer. Without `onStreamingResult`
		// (JSON/agent/silent runs) the SortedMap polling has no sink — running
		// it anyway burns HTTP quota and risks the one-shot stderr warning
		// leaking into structured output. Skip the SortedMap path entirely;
		// the final batched envelope still drives per-package output files.
		const streaming =
			onStreamingResult !== undefined
				? buildStreaming({
						credentials: workStealingCredentials,
						generateUuid: generateUuid ?? randomUUID,
						onStreamingResult,
					})
				: undefined;

		const script = generateWorkStealingScript(
			inputs,
			prepared.queueId,
			prepared.invisibilityWindowSeconds,
			streaming !== undefined ? { streaming: { sortedMapId: streaming.sortedMapId } } : {},
		);

		return {
			parallel,
			scriptOverride: script,
			...(streaming !== undefined ? { streaming: streaming.hooks } : {}),
			workStealing: true,
		};
	}

	return { scriptOverride: generateMaterializerScript(inputs) };
}

/**
 * Resolve a `--testPathPattern` against this package's files Node-side, then
 * forward an Instance-namespace basename pattern (see {@link narrowForLuauRun}).
 *
 * A pattern that matches no file in this package simply targets a different
 * package: keep the (zero-matching) raw pattern so Jest-on-Roblox runs nothing,
 * and set `passWithNoTests` so it doesn't `exit(1)`. The raw pattern is
 * load-bearing here — clearing it would drop the filter entirely and make the
 * Luau side fall back to `testMatch`, running the whole package.
 */
function narrowPackageTestPathPattern(
	packageConfig: ResolvedConfig,
	cli: CliOptions,
): ResolvedConfig {
	if (packageConfig.testPathPattern === undefined) {
		return packageConfig;
	}

	const { files } = discoverTestFiles(packageConfig);
	// `mergeCliWithConfig` no longer folds the typecheck flags into the resolved
	// config, so resolve the CLI layer here to keep `--typecheckOnly` honored
	// when classifying runtime files for the narrow.
	const typecheck = resolveTypecheckConfig({
		cli: { enabled: cli.typecheck, only: cli.typecheckOnly, tsconfig: cli.typecheckTsconfig },
		root: packageConfig.typecheck,
	});
	const { runtimeFiles } = classifyTestFiles(files, typecheck);
	if (runtimeFiles.length === 0) {
		return { ...packageConfig, passWithNoTests: true };
	}

	return narrowForLuauRun(packageConfig, runtimeFiles, true);
}

async function loadPackages(input: {
	cli: CliOptions;
	packageInfos: Array<PackageInfo>;
	timing: TimingCollector;
}): Promise<Array<LoadedPackage>> {
	const { cli, packageInfos, timing } = input;
	const loaded: Array<LoadedPackage> = [];

	for (const info of packageInfos) {
		const fileConfig = await timing.profileAsync(`load-config:${info.name}`, async () => {
			return loadConfig(undefined, info.packageDirectory);
		});
		const packageConfig = narrowPackageTestPathPattern(
			mergeCliWithConfig(cli, fileConfig),
			cli,
		);

		// `rojoProject` is resolved per-package only — the workspace-root
		// config is intentionally not consulted. A `pkg ?? config ?? DEFAULT`
		// chain would let a workspace-root value silently override the
		// per-package default for packages that omitted the field.
		const rojoProject = packageConfig.rojoProject ?? ROJO_PROJECT_DEFAULT;

		// Propagate per-pkg coverage knobs to the descriptor so
		// `prepareWorkspaceCoverage` sees the merged values, not just the
		// workspace-root config. Per-pkg overrides workspace-root: previously
		// the workspace-prepare matcher was reading from the root config and
		// silently dropping per-pkg patterns set via `jest.shared.ts` extends.
		//
		// `coveragePathIgnorePatterns` always resolves post-merge — both pkg
		// and root carry the `DEFAULT_CONFIG` 6-pattern array when nothing
		// explicit is set. Passing it unconditionally would make every
		// descriptor "override" the root, dropping a workspace-root custom
		// value for packages that wanted to inherit it. `resolveConfig`
		// (loader.ts:42) builds via `Object.assign({}, DEFAULT_CONFIG, ...)`
		// — when the package's `test` block omits the key, the field keeps
		// the `DEFAULT_CONFIG` reference verbatim. Reference identity is the
		// "user explicitly set this" signal; treat ref-equal as "inherit
		// root" by leaving the descriptor field undefined.
		const hasExplicitIgnore =
			packageConfig.coveragePathIgnorePatterns !== DEFAULT_CONFIG.coveragePathIgnorePatterns;
		// Per-pkg `coverageCache` opt-out drives the workspace cache gate.
		// Pass it through only when the pkg's value diverges from the
		// default; an undefined descriptor field means "inherit
		// DEFAULT_CONFIG" inside `prepareWorkspaceCoverage`.
		const hasExplicitCoverageCache =
			packageConfig.coverageCache !== DEFAULT_CONFIG.coverageCache;
		loaded.push({
			descriptor: {
				...(hasExplicitCoverageCache ? { coverageCache: packageConfig.coverageCache } : {}),
				...(hasExplicitIgnore
					? { coveragePathIgnorePatterns: packageConfig.coveragePathIgnorePatterns }
					: {}),
				...(packageConfig.luauRoots !== undefined
					? { luauRoots: packageConfig.luauRoots }
					: {}),
				name: info.name,
				packageDirectory: info.packageDirectory,
				rojoProjectPath: path.resolve(info.packageDirectory, rojoProject),
			},
			info,
			pkgConfig: packageConfig,
		});
	}

	return loaded;
}

function synthesizeVirtualProjectEntry(
	packageName: string,
	packageConfig: ResolvedConfig,
	rojoTree: RojoTreeNode,
	packageDirectory: string,
): InlineProjectConfig {
	const mountPaths: Array<string> = [];
	collectPaths(rojoTree, mountPaths);

	// Use the FS classifier so dotted-name directories (e.g. `src/has.dot`)
	// are not mis-classified as files. `path.posix.extname` would treat
	// `.dot` as an extension and skip the directory entirely.
	const classify = createFsClassifier(packageDirectory);
	const directoryRoots = mountPaths.filter((value) => classify(value) === "directory");

	const include = directoryRoots.flatMap((root) => {
		return packageConfig.testMatch.map((pattern) => path.posix.join(root, pattern));
	});

	// Carry the package's global `test.exclude` onto the virtual project so
	// `discoverProjectTestFiles` subtracts it — the workspace analogue of
	// single-mode `test.exclude`. Explicit `projects:` carry their own
	// per-project `exclude` instead and never reach this synthesis.
	return {
		test: {
			displayName: packageName,
			...(packageConfig.exclude !== undefined ? { exclude: packageConfig.exclude } : {}),
			include,
		},
	};
}

function readRawProjects(config: ResolvedConfig): Array<ProjectEntry> | undefined {
	// `ResolvedConfig.projects` is structurally typed `Array<string>`
	// post-resolution, but workspace mode reads the field BEFORE
	// per-package resolution runs, when entries are still raw
	// `ProjectEntry` (string paths or `{ test }` inline configs). The
	// downcast is bounded by `Array.isArray` and consumers that fail on
	// malformed entries.
	const { projects } = config as unknown as { projects?: unknown };
	if (!Array.isArray(projects)) {
		return undefined;
	}

	return projects as Array<ProjectEntry>;
}

function resolveProjectEntries(
	packageName: string,
	packageConfig: ResolvedConfig,
	rojoTree: RojoTreeNode,
	packageDirectory: string,
): Array<ProjectEntry> {
	const rawProjects = readRawProjects(packageConfig);
	if (rawProjects !== undefined && rawProjects.length > 0) {
		return rawProjects;
	}

	return [synthesizeVirtualProjectEntry(packageName, packageConfig, rojoTree, packageDirectory)];
}

function loadPackageRojoTree(rojoProjectPath: string, packageDirectory: string): RojoTreeNode {
	// `loadRojoProject` resolves nested projects and expresses every `$path`
	// relative to the project file's directory. Include roots, however, resolve
	// relative to the package directory. When the project file lives in a
	// subdirectory (e.g. `test/default.project.json`) the two bases diverge, so
	// rebase the tree to package-relative paths so mount resolution
	// (findInTree / collectMounts) compares like-for-like.
	const rojoDirectory = path.dirname(rojoProjectPath);
	const project = loadRojoProject(rojoProjectPath);
	return rebaseTreePaths(project.tree, rojoDirectory, packageDirectory);
}

function applySetupResolver(
	config: Pick<ResolvedConfig, "setupFiles" | "setupFilesAfterEnv">,
	resolve: (input: string) => string,
): void {
	if (config.setupFiles !== undefined) {
		config.setupFiles = config.setupFiles.map(resolve);
	}

	if (config.setupFilesAfterEnv !== undefined) {
		config.setupFilesAfterEnv = config.setupFilesAfterEnv.map(resolve);
	}
}

async function resolvePackageContexts(input: {
	cacheDirectory: string;
	loaded: Array<LoadedPackage>;
}): Promise<Array<PackageContext>> {
	const { cacheDirectory, loaded } = input;
	const contexts: Array<PackageContext> = [];

	for (const entry of loaded) {
		const { descriptor, info, pkgConfig } = entry;
		const rojoTree = loadPackageRojoTree(
			descriptor.rojoProjectPath,
			descriptor.packageDirectory,
		);
		const projectEntries = resolveProjectEntries(
			info.name,
			pkgConfig,
			rojoTree,
			info.packageDirectory,
		);
		const projects = await resolveAllProjects(
			projectEntries,
			pkgConfig,
			rojoTree,
			info.packageDirectory,
		);

		// Resolve setupFiles / setupFilesAfterEnv for every project against
		// the package's own rojo tree. Without this, the materializer
		// payload carries raw filesystem paths that Jest cannot find as
		// ModuleScript Instances.
		//
		// `createSetupResolver` eagerly builds a `RojoResolver` (a full
		// project-tree filesystem walk) — by far the dominant resolveContexts
		// cost. Skip it entirely when no project declares setup files, mirroring
		// the guard in `resolveSetupFilePaths` (run/discovery.ts). Packages with
		// no setup files (the common case) then pay nothing here.
		const needsSetupResolution = projects.some((project) => {
			return (
				project.config.setupFiles !== undefined ||
				project.config.setupFilesAfterEnv !== undefined
			);
		});
		if (needsSetupResolution) {
			const resolveSetup = createSetupResolver({
				configDirectory: info.packageDirectory,
				rojoConfigPath: descriptor.rojoProjectPath,
			});
			for (const project of projects) {
				applySetupResolver(project.config, resolveSetup);
			}
		}

		contexts.push({
			cacheRoot: path.join(cacheDirectory, info.name),
			descriptor,
			info,
			pkgConfig,
			projects,
		});
	}

	return contexts;
}

function applyProjectFilter(
	contexts: Array<PackageContext>,
	filter: Array<string> | undefined,
): Array<PackageContext> {
	if (filter === undefined || filter.length === 0) {
		return contexts;
	}

	const wanted = new Set(filter);
	const available = new Set<string>();
	for (const ctx of contexts) {
		for (const project of ctx.projects) {
			available.add(project.displayName);
		}
	}

	const unknown = filter.filter((name) => !available.has(name));
	if (unknown.length > 0) {
		throw new Error(
			`Unknown project name(s): ${unknown.join(", ")}. Available: ${[...available].join(", ")}`,
		);
	}

	return contexts
		.map((ctx) => {
			return {
				...ctx,
				projects: ctx.projects.filter((project) => wanted.has(project.displayName)),
			};
		})
		.filter((ctx) => ctx.projects.length > 0);
}

function buildProjectExecutionConfig(
	packageConfig: ResolvedConfig,
	project: ResolvedProjectConfig,
): ResolvedConfig {
	return {
		...project.config,
		passWithNoTests: packageConfig.passWithNoTests,
		projects: project.projects,
		rootDir: packageConfig.rootDir,
		testMatch: project.testMatch,
	};
}

function discoverProjectTestFiles(
	project: ResolvedProjectConfig,
	packageDirectory: string,
): Array<string> {
	const found: Array<string> = [];
	for (const pattern of project.include) {
		found.push(...globSync(pattern, { cwd: packageDirectory }));
	}

	// Workspace mode never consumes positional file args (no auto-pick path), so
	// the exclude gate is unconditional — there is no user-chosen file set to
	// bypass. Runtime discovery globs the Runtime `include` only; Type Tests are
	// discovered separately by `discoverProjectTypeTests` from the `-d` include.
	return applyExcludes([...new Set(found)], project.exclude);
}

// Per-(package, project) Type Test discovery, mirroring multi's
// `collectPendingJobs`: derive the `-d` include from the project's Runtime
// `include` (unless an explicit `test.typecheck.include` is set), glob it
// against the package directory, classify by `TYPE_TEST_PATTERN`, then subtract
// `test.typecheck.exclude`. Returns absolute paths so `runTypecheck` reads them
// cwd-independently (workspace mode runs from any directory) while still keying
// each file result package-relative against `rootDir = packageDirectory`.
function discoverProjectTypeTests(
	project: ResolvedProjectConfig,
	typecheck: ResolvedTypecheckConfig,
	packageDirectory: string,
): Array<string> {
	const include = typecheck.include ?? deriveTypecheckInclude(project.include);
	const found: Array<string> = [];
	for (const pattern of include) {
		found.push(...globSync(pattern, { cwd: packageDirectory }));
	}

	const { typeTestFiles } = classifyTestFiles([...new Set(found)], typecheck);
	return applyExcludes(typeTestFiles, typecheck.exclude).map((file) => {
		return path.resolve(packageDirectory, file);
	});
}

function applyEmptyPackagePolicy(
	allEntries: Array<PendingEntry>,
	contexts: Array<PackageContext>,
	typeTestPackages: ReadonlySet<string>,
): { emptyPackageErrors: Array<string>; pending: Array<PendingEntry> } {
	const passByPackage = new Map<string, boolean>();
	for (const ctx of contexts) {
		passByPackage.set(ctx.info.name, ctx.pkgConfig.passWithNoTests);
	}

	const entriesByPackage = new Map<string, Array<PendingEntry>>();
	for (const entry of allEntries) {
		let group = entriesByPackage.get(entry.pkg);
		if (group === undefined) {
			group = [];
			entriesByPackage.set(entry.pkg, group);
		}

		group.push(entry);
	}

	const emptyPackageErrors: Array<string> = [];
	const pending: Array<PendingEntry> = [];
	for (const [package_, entries] of entriesByPackage) {
		const populated = entries.filter((entry) => entry.testFiles.length > 0);
		if (populated.length > 0) {
			pending.push(...populated);
			continue;
		}

		// A package whose only tests are Type Tests (no runtime specs, or
		// `--typecheckOnly`) is NOT empty — its type pass still reports. Mirrors
		// multi's `projectResults.length === 0 && typecheckResult !== undefined`
		// valid-result branch.
		if (passByPackage.get(package_) === true || typeTestPackages.has(package_)) {
			continue;
		}

		emptyPackageErrors.push(`No test files found in package ${package_}`);
	}

	return { emptyPackageErrors, pending };
}

function collectPendingEntries(contexts: Array<PackageContext>, cli: CliOptions): DiscoveredTests {
	const cliTypecheck: TypecheckCliOptions = {
		enabled: cli.typecheck,
		only: cli.typecheckOnly,
		tsconfig: cli.typecheckTsconfig,
	};
	const pending: Array<PendingEntry> = [];
	const typeTestEntries: Array<TypecheckGroupEntry> = [];
	const typeTestProjects: Array<TypeTestProject> = [];
	const typecheckByDirectory = new Map<string, PackageTypecheck>();

	for (const ctx of contexts) {
		const { packageDirectory } = ctx.info;
		// `ignoreSourceErrors`/`spawnTimeout` are package-wide (no project
		// layer); the per-project resolution below only drives
		// enabled/include/exclude and the grouping tsconfig.
		const packageTypecheck = resolveTypecheckConfig({
			cli: cliTypecheck,
			root: ctx.pkgConfig.typecheck,
		});

		for (const project of ctx.projects) {
			const typecheck = resolveTypecheckConfig({
				cli: cliTypecheck,
				project: project.typecheck,
				root: ctx.pkgConfig.typecheck,
			});
			const projectConfig = buildProjectExecutionConfig(ctx.pkgConfig, project);
			// `--typecheckOnly` / per-project `only` means "don't run runtime
			// tests": zero the runtime file set so the package contributes only
			// Type Tests (the short-circuit then skips the place build +
			// dispatch).
			const testFiles = typecheck.only
				? []
				: discoverProjectTestFiles(project, packageDirectory);
			pending.push({ pkg: ctx.info.name, project, projectConfig, testFiles });

			if (!typecheck.enabled) {
				continue;
			}

			const typeTestFiles = discoverProjectTypeTests(project, typecheck, packageDirectory);
			if (typeTestFiles.length === 0) {
				continue;
			}

			typeTestProjects.push({ pkg: ctx.info.name, project: project.displayName });

			// cwd is the PACKAGE directory (not the workspace root): distinct
			// packages form distinct `(cwd, tsconfig)` groups even when they
			// share the same relative tsconfig name, while projects within a
			// package that share a tsconfig collapse to one tsgo pass.
			typeTestEntries.push({
				cwd: packageDirectory,
				files: typeTestFiles,
				...(typecheck.tsconfig !== undefined ? { tsconfig: typecheck.tsconfig } : {}),
			});
			typecheckByDirectory.set(packageDirectory, {
				ignoreSourceErrors: packageTypecheck.ignoreSourceErrors,
				pkg: ctx.info.name,
				spawnTimeout: packageTypecheck.spawnTimeout,
			});
		}
	}

	return { pending, typecheckByDirectory, typeTestEntries, typeTestProjects };
}

// `runTypecheck` keys file results by `path.relative(cwd, file)` — package
// relative, so `src/index.spec-d.ts` from two packages would be
// indistinguishable once merged. Prefix the package name (parity with the
// runtime path's `pkg › project` display) so each merged file result carries
// package identity.
function composePackageIdentity(result: JestResult, package_: string): JestResult {
	return {
		...result,
		testResults: result.testResults.map((file) => {
			return { ...file, testFilePath: `${package_}/${file.testFilePath}` };
		}),
	};
}

async function runWorkspaceTypecheckPass(
	entries: Array<TypecheckGroupEntry>,
	typecheckByDirectory: Map<string, PackageTypecheck>,
): Promise<WorkspaceTypecheckPass> {
	const byPackage = new Map<string, JestResult>();
	const outcome = await runTypecheckPass(entries, async (group) => {
		// Every group's cwd is a package directory recorded in
		// `typecheckByDirectory` in the same loop iteration that pushed the
		// entry, so the lookup is always present.
		// eslint-disable-next-line ts/no-non-null-assertion -- invariant: cwd ∈ typecheckByDirectory
		const policy = typecheckByDirectory.get(group.cwd)!;
		const raw = await runTypecheck({
			files: group.files,
			ignoreSourceErrors: policy.ignoreSourceErrors,
			rootDir: group.cwd,
			spawnTimeout: policy.spawnTimeout,
			...(group.tsconfig !== undefined ? { tsconfig: group.tsconfig } : {}),
		});
		const stamped = composePackageIdentity(raw, policy.pkg);
		// A package with two distinct-tsconfig groups folds into one per-package
		// result; `mergeResults` returns `stamped` verbatim for the first group.
		byPackage.set(policy.pkg, mergeResults(stamped, byPackage.get(policy.pkg)));
		return stamped;
	});
	return { byPackage, outcome };
}

// Records the tsgo span (when the pass actually ran) and builds the runner
// output from the runtime `results` plus the merged Type Test result. Shared by
// the overlap path (where the pass may be empty — typecheck off) and the
// `--typecheckOnly` short-circuit, so both branches stay exercised regardless of
// which path a given run takes.
function attachTypecheck(
	results: Array<WorkspaceProjectResult>,
	pass: TypecheckPassOutcome,
	timing: TimingCollector,
): WorkspaceRunnerOutput {
	if (pass.elapsedMs > 0) {
		timing.record("runTypecheck", pass.elapsedMs);
	}

	return {
		results,
		...(pass.result !== undefined ? { typecheckResult: pass.result } : {}),
	};
}

// Writes the aggregate result file (runtime ∪ Type Tests) to the workspace
// `outputFile` sink. The runner owns this sink — `output.ts` only writes the
// single/multi aggregates — so both the runtime path (where `typecheck` may be
// undefined) and the `--typecheckOnly` short-circuit (where `runtime` is
// undefined) route through here to keep the Type Test result from being dropped
// from the JSON output. `mergeResults` collapses to whichever side is present.
async function writeWorkspaceOutputFile(
	outputFile: string,
	runtime: JestResult | undefined,
	typecheck: JestResult | undefined,
): Promise<void> {
	await writeJsonFile(mergeResults(typecheck, runtime), outputFile);
}

// The `--typecheckOnly` / no-runtime-specs short-circuit: run only the host-side
// Type Test pass, write it to the workspace `outputFile` sink (no runtime side),
// and return it. Skips instrumentation, the synthesized place build, and Open
// Cloud dispatch entirely.
async function runTypecheckOnlyWorkspace(input: {
	runOptions: WorkspaceRunOptions;
	timing: TimingCollector;
	typecheckByDirectory: Map<string, PackageTypecheck>;
	typeTestEntries: Array<TypecheckGroupEntry>;
	typeTestProjects: Array<TypeTestProject>;
	workspaceRoot: string;
}): Promise<WorkspaceRunnerOutput> {
	const typecheckPass = await runWorkspaceTypecheckPass(
		input.typeTestEntries,
		input.typecheckByDirectory,
	);
	if (input.runOptions.outputFile !== undefined) {
		await writeWorkspaceOutputFile(
			input.runOptions.outputFile,
			undefined,
			typecheckPass.outcome.result,
		);
	}

	// Per-package files route through the same writer as the runtime path: there
	// is no runtime side here, so every entry is the package's Type Test result
	// under each of its type-test projects.
	if (input.runOptions.workspaceOutputFile) {
		writePerPackageOutputFiles(
			input.workspaceRoot,
			buildPerPackageResults([], [], typecheckPass.byPackage, input.typeTestProjects),
		);
	}

	return attachTypecheck([], typecheckPass.outcome, input.timing);
}

function attachCoverageManifests(
	results: Array<ExecuteResult>,
	pending: Array<PendingEntry>,
	coverageByPackage: Map<string, WorkspacePackageCoverage>,
): Array<WorkspaceProjectResult> {
	return results.map((result, index) => {
		// eslint-disable-next-line ts/no-non-null-assertion -- runProjects preserves order
		const pendingEntry = pending[index]!;
		const coverage = coverageByPackage.get(pendingEntry.pkg);
		return {
			coverageManifest: coverage?.manifest,
			displayName: pendingEntry.project.displayName,
			pkg: pendingEntry.pkg,
			result,
		};
	});
}

const PER_PACKAGE_OUTPUT_DIRECTORY = path.join(".jest-roblox", "output");
const FILESYSTEM_UNSAFE = /[^\w@.-]+/g;

interface PerPackageGameOutputFile {
	count: number;
	path: string;
}

interface EmitWorkspaceGameOutputInput {
	pending: Array<PendingEntry>;
	results: Array<ExecuteResult>;
	runOptions: WorkspaceRunOptions;
	verbose?: boolean;
	workspaceRoot: string;
}

// One per-package result file: the merged (runtime ∪ Type Test) result for a
// single (package, project) pair, written as `<pkg>--<project>.jest-output.log`.
interface PerPackageResultEntry {
	pkg: string;
	project: string;
	result: JestResult;
}

function sanitizePathSegment(segment: string): string {
	return segment.replace(FILESYSTEM_UNSAFE, "-");
}

// JSON-encode the `(pkg, project)` pair so neither segment's content can collide
// into another pair's key (parity with `groupTypecheckByTsconfig`).
function projectKey(package_: string, project: string): string {
	return JSON.stringify([package_, project]);
}

// Builds the per-(package, project) files the workspace writes when
// `workspace.outputFile` is on: each file mirrors the aggregate at finer
// granularity via the shared `mergeResults`, so the per-package sink can't drift
// from the aggregate. Runtime pairs come from `pending`/`results`; Type Test
// pairs reuse each package's whole type result (the tsgo pass collapses a
// package's projects, so package-level is the finest honest split) under every
// project that owns Type Tests. A pair present on both sides merges.
function buildPerPackageResults(
	pending: Array<PendingEntry>,
	results: Array<ExecuteResult>,
	typeByPackage: Map<string, JestResult>,
	typeTestProjects: Array<TypeTestProject>,
): Array<PerPackageResultEntry> {
	const byKey = new Map<string, PerPackageResultEntry>();

	for (const [index, result] of results.entries()) {
		// eslint-disable-next-line ts/no-non-null-assertion -- runProjects preserves order
		const entry = pending[index]!;
		const { displayName } = entry.project;
		byKey.set(projectKey(entry.pkg, displayName), {
			pkg: entry.pkg,
			project: displayName,
			result: result.result,
		});
	}

	for (const { pkg, project } of typeTestProjects) {
		// Every type-test project's package ran a group, so `byPackage` has it.
		// eslint-disable-next-line ts/no-non-null-assertion -- invariant: pkg ran a type pass
		const typeResult = typeByPackage.get(pkg)!;
		const key = projectKey(pkg, project);
		byKey.set(key, {
			pkg,
			project,
			result: mergeResults(typeResult, byKey.get(key)?.result),
		});
	}

	return [...byKey.values()];
}

function writePerPackageOutputFiles(
	workspaceRoot: string,
	entries: Array<PerPackageResultEntry>,
): void {
	const directory = path.join(workspaceRoot, PER_PACKAGE_OUTPUT_DIRECTORY);
	fs.mkdirSync(directory, { recursive: true });

	for (const entry of entries) {
		const filename = `${sanitizePathSegment(entry.pkg)}--${sanitizePathSegment(
			entry.project,
		)}.jest-output.log`;
		fs.writeFileSync(
			path.join(directory, filename),
			JSON.stringify(entry.result, null, 2),
			"utf8",
		);
	}
}

// Sibling of writePerPackageOutputFiles; emits a `.game-output.log`
// companion alongside each (pkg, project) result file under
// `.jest-roblox/output/`. The path is built absolute against workspaceRoot
// before calling writeGameOutput — that helper calls path.resolve which
// would otherwise fall back to process.cwd() and silently mis-route files.
// Returns each written file's path and entry count so the caller can build
// notices for the non-empty ones.
function writePerPackageGameOutputFiles(
	workspaceRoot: string,
	pending: Array<PendingEntry>,
	results: Array<ExecuteResult>,
): Array<PerPackageGameOutputFile> {
	const directory = path.join(workspaceRoot, PER_PACKAGE_OUTPUT_DIRECTORY);

	return results.map((result, index) => {
		// eslint-disable-next-line ts/no-non-null-assertion -- runProjects preserves order
		const entry = pending[index]!;
		const filename = `${sanitizePathSegment(entry.pkg)}--${sanitizePathSegment(
			entry.project.displayName,
		)}.game-output.log`;
		const filePath = path.join(directory, filename);
		const entries = parseGameOutput(result.gameOutput);
		writeGameOutput(filePath, entries);
		return { count: entries.length, path: filePath };
	});
}

// Writes the configured Game Output sinks for a workspace run and announces
// exactly one of them. Aggregated (single grouped file, top-level
// `gameOutput`) and Per-package (`.jest-roblox/output/` files,
// `workspace.gameOutput`) are independent; either, both, or neither may be
// active. Humans prefer the single aggregate (one place to look); agents
// prefer the per-package files (smaller, targeted context).
function emitWorkspaceGameOutput(input: EmitWorkspaceGameOutputInput): void {
	const { pending, results, runOptions, verbose, workspaceRoot } = input;
	const aggregatePath = runOptions.gameOutput;

	let aggregateNotice = "";
	if (aggregatePath !== undefined) {
		const groups = buildGroupedGameOutput(
			results.map((result, index) => {
				// eslint-disable-next-line ts/no-non-null-assertion -- runProjects preserves order
				const entry = pending[index]!;
				return {
					package: entry.pkg,
					project: entry.project.displayName,
					raw: result.gameOutput,
				};
			}),
		);
		writeGroupedGameOutput(aggregatePath, groups);
		aggregateNotice = formatGameOutputNotice(aggregatePath, countGroupedEntries(groups));
	}

	let perPackageNotices: Array<string> = [];
	if (runOptions.workspaceGameOutput) {
		perPackageNotices = writePerPackageGameOutputFiles(workspaceRoot, pending, results)
			.map((file) => formatGameOutputNotice(file.path, file.count))
			.filter((notice) => notice !== "");
	}

	if (runOptions.silent) {
		return;
	}

	const aggregateActive = aggregatePath !== undefined;
	const perPackageActive = runOptions.workspaceGameOutput;
	const preferPerPackage = usesAgentFormatter(runOptions.formatters, verbose);

	const announcePerPackage = preferPerPackage
		? perPackageActive
		: !aggregateActive && perPackageActive;

	if (announcePerPackage) {
		for (const notice of perPackageNotices) {
			console.error(notice);
		}
	} else if (aggregateActive && aggregateNotice !== "") {
		console.error(aggregateNotice);
	}
}

function writePreflightErrors(errors: Array<PreflightError>): void {
	process.stderr.write("Pre-flight validation failed:\n");
	for (const error of errors) {
		process.stderr.write(`  ${error.package}: ${error.reason}\n`);
	}
}

function liveProjectsByPackage(pending: Array<PendingEntry>): Map<string, Set<string>> {
	const live = new Map<string, Set<string>>();
	for (const entry of pending) {
		let names = live.get(entry.pkg);
		if (names === undefined) {
			names = new Set();
			live.set(entry.pkg, names);
		}

		names.add(entry.project.displayName);
	}

	return live;
}

// stubMounts inject `jest.config` at each rojoMount leaf. Projects whose
// runtime discovery returned zero files are already dropped from `pending`
// (workspace-runner.ts ~L162), so their stubs would never run. Emitting them
// anyway is worse than wasteful: a project's `outDir` may legitimately not
// exist on disk when the compiler had nothing to produce, and the synthesizer
// would fail walking that missing path (e.g. `out-test/src` when no specs
// exist). Skip stub emission for non-live projects; the package's own rojo
// tree still mounts so cross-package consumers resolve normally.
function writeStubsAndBuildDescriptors(
	contexts: Array<PackageContext>,
	liveProjects: Map<string, Set<string>>,
): Array<PackageDescriptor> {
	return contexts.map((ctx) => {
		const live = liveProjects.get(ctx.info.name) ?? new Set<string>();
		const liveProjectsForPackage = ctx.projects.filter((project) =>
			live.has(project.displayName),
		);

		// `generateProjectStubs` skips per-mount when the user already has
		// a `jest.config.luau` on disk at that mount, so pass the full
		// live list. The `stubMounts` loop below applies the same filter
		// so we only emit `$path` references for mounts that actually got
		// a cache stub written.
		generateProjectStubs(liveProjectsForPackage, ctx.info.packageDirectory, ctx.cacheRoot);

		const stubMounts: Array<StubMount> = [];
		for (const project of liveProjectsForPackage) {
			for (const mount of project.rojoMounts) {
				const sourceMount = path.resolve(ctx.info.packageDirectory, mount.fsPath);
				if (hasUserAuthoredConfig(sourceMount)) {
					continue;
				}

				stubMounts.push({
					absStubPath: path.resolve(ctx.cacheRoot, mount.fsPath, STUB_FILENAME),
					dataModelPath: mount.dataModelPath,
				});
			}
		}

		return { ...ctx.descriptor, stubMounts };
	});
}
