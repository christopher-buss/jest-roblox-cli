import { collectPaths, loadRojoProject, rebaseTreePaths } from "@isentinel/rojo-utils";

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import type { Backend, StreamingHooks } from "./backends/interface.ts";
import { loadConfig } from "./config/loader.ts";
import { mergeCliWithConfig } from "./config/merge.ts";
import { narrowForLuauRun } from "./config/narrow-by-files.ts";
import type { ResolvedProjectConfig } from "./config/projects.ts";
import { createFsClassifier, resolveAllProjects } from "./config/projects.ts";
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
	prepareWorkspaceCoverage,
	type WorkspacePackageCoverage,
} from "./coverage/workspace-prepare.ts";
import { type ExecuteResult, runProjects, type RunProjectsOptions } from "./executor.ts";
import { writeJsonFile } from "./formatters/json.ts";
import { usesAgentFormatter } from "./formatters/utils.ts";
import { StreamingResultClient } from "./memory-store/sorted-map-client.ts";
import { prepareWorkStealingQueue } from "./memory-store/work-stealing.ts";
import { mergeProjectResults } from "./output.ts";
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
	backend: Backend;
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

type WorkspaceDispatchSpec = Pick<
	RunProjectsOptions,
	"parallel" | "scriptOverride" | "streaming" | "workStealing"
>;

export async function runWorkspace(
	options: RunWorkspaceOptions,
): Promise<Array<WorkspaceProjectResult> | undefined> {
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
): Promise<Array<WorkspaceProjectResult> | undefined> {
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
	const { emptyPackageErrors, filteredContexts, pending } = timing.profile(
		"discoverTests",
		() => {
			const discoveredContexts = applyProjectFilter(contexts, cli.project);
			const allEntries = collectPendingEntries(discoveredContexts);
			const policy = applyEmptyPackagePolicy(allEntries, discoveredContexts);
			return {
				emptyPackageErrors: policy.emptyPackageErrors,
				filteredContexts: discoveredContexts,
				pending: policy.pending,
			};
		},
	);
	if (emptyPackageErrors.length > 0) {
		for (const error of emptyPackageErrors) {
			process.stderr.write(`${error}\n`);
		}

		return undefined;
	}

	if (pending.length === 0) {
		return [];
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

	timing.profile("rojoBuild", () => {
		buildPlace({
			packages: descriptorsWithStubs,
			placeFile: synthRbxlPath,
			projectFile: synthProjectPath,
		});
	});

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

	const { results } = await timing.profileAsync("runProjects", async () => {
		return runProjects({
			backend,
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
	});

	if (runOptions.workspaceOutputFile) {
		writePerPackageOutputFiles(workspaceRoot, pending, results);
	}

	if (runOptions.outputFile !== undefined) {
		await writeJsonFile(mergeProjectResults(results).result, runOptions.outputFile);
	}

	emitWorkspaceGameOutput({
		pending,
		results,
		runOptions,
		verbose: options.cli.verbose,
		workspaceRoot,
	});

	return attachCoverageManifests(results, pending, coverageByPackage);
}

const PER_PACKAGE_TIMEOUT_SECONDS = 60;

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

	return {
		test: {
			displayName: packageName,
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

	return [...new Set(found)];
}

function applyEmptyPackagePolicy(
	allEntries: Array<PendingEntry>,
	contexts: Array<PackageContext>,
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

		if (passByPackage.get(package_) === true) {
			continue;
		}

		emptyPackageErrors.push(`No test files found in package ${package_}`);
	}

	return { emptyPackageErrors, pending };
}

function collectPendingEntries(contexts: Array<PackageContext>): Array<PendingEntry> {
	const pending: Array<PendingEntry> = [];

	for (const ctx of contexts) {
		for (const project of ctx.projects) {
			const projectConfig = buildProjectExecutionConfig(ctx.pkgConfig, project);
			const testFiles = discoverProjectTestFiles(project, ctx.info.packageDirectory);
			pending.push({
				pkg: ctx.info.name,
				project,
				projectConfig,
				testFiles,
			});
		}
	}

	return pending;
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

function sanitizePathSegment(segment: string): string {
	return segment.replace(FILESYSTEM_UNSAFE, "-");
}

function writePerPackageOutputFiles(
	workspaceRoot: string,
	pending: Array<PendingEntry>,
	results: Array<ExecuteResult>,
): void {
	const directory = path.join(workspaceRoot, PER_PACKAGE_OUTPUT_DIRECTORY);
	fs.mkdirSync(directory, { recursive: true });

	for (const [index, result] of results.entries()) {
		// eslint-disable-next-line ts/no-non-null-assertion -- runProjects preserves order
		const entry = pending[index]!;
		const filename = `${sanitizePathSegment(entry.pkg)}--${sanitizePathSegment(
			entry.project.displayName,
		)}.jest-output.log`;
		fs.writeFileSync(
			path.join(directory, filename),
			JSON.stringify(result.result, null, 2),
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
