import { resolveNestedProjects } from "@isentinel/rojo-utils";

import { type } from "arktype";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import packageJson from "../../package.json" with { type: "json" };
import { resolveBackend } from "../backends/auto.ts";
import type { Backend } from "../backends/interface.ts";
import { applyExcludes } from "../config/apply-excludes.ts";
import { deriveTypecheckInclude } from "../config/derive-typecheck-include.ts";
import { collectProjectRoots, filterProjectsByFiles } from "../config/filter-projects-by-files.ts";
import { narrowForLuauRun } from "../config/narrow-by-files.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import { resolveAllProjects } from "../config/projects.ts";
import type { TypecheckCliOptions } from "../config/resolve-typecheck-config.ts";
import { resolveTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ProjectEntry, ResolvedConfig } from "../config/schema.ts";
import { resolvePlaceFilePath } from "../config/schema.ts";
import {
	cleanLeftoverStubs,
	generateProjectStubs,
	hasUserAuthoredConfig,
	STUB_FILENAME,
	syncStubsToShadowDirectory,
} from "../config/stubs.ts";
import {
	type CoverageDisplayPredicate,
	projectRootFilter,
	sourceTwinFilter,
} from "../coverage-pipeline/agent-table-filter.ts";
import type { AttributionResult } from "../coverage-pipeline/attribution.ts";
import { mergeAttribution } from "../coverage-pipeline/attribution.ts";
import type { CoverageArtifacts } from "../coverage-pipeline/build-manifest.ts";
import { deriveCoverageFromIncludes } from "../coverage-pipeline/derive-coverage-from.ts";
import { mergeRawCoverage } from "../coverage-pipeline/merge-raw-coverage.ts";
import { prepareCoverage, toCoverageArtifacts } from "../coverage-pipeline/prepare.ts";
import type { RawCoverageData } from "../coverage-pipeline/types.ts";
import { runProjects } from "../executor.ts";
import { combineSourceMappers, type SourceMapper } from "../source-mapper/index.ts";
import { buildPlace } from "../staging/place-builder.ts";
import type { StubMount } from "../staging/synthesizer.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import type { TypecheckGroupEntry } from "../typecheck/group-by-tsconfig.ts";
import { runTypecheckPass } from "../typecheck/group-by-tsconfig.ts";
import { runTypecheck } from "../typecheck/runner.ts";
import { rojoProjectSchema } from "../types/rojo.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { classifyTestFiles, discoverTestFiles, resolveAllSetupFilePaths } from "./discovery.ts";
import { toBuildManifestProjects } from "./manifest-projects.ts";
import { emitRunHeader } from "./run-header.ts";
import type { MultiProjectMerged, MultiRunResult, ProjectResult, RunOptions } from "./types.ts";

const DEFAULT_ROJO_PROJECT = "default.project.json";
const VERSION: string = packageJson.version;

export interface MultiRunOptions extends RunOptions {
	rawProjects: Array<ProjectEntry>;
}

type ParallelOption = "auto" | number | undefined;

interface PendingJob {
	config: ResolvedConfig;
	displayColor?: string;
	displayName: string;
	runtimeFiles: Array<string>;
	// Mount paths the Studio runner should inject `jest.config` into; empty
	// when every mount already has a user-authored config on disk.
	runtimeInjectionPaths: Array<string>;
}

interface CollectPendingJobsArguments {
	cliFiles: Array<string> | undefined;
	cliTypecheck: TypecheckCliOptions;
	effectivePlaceFile: string;
	/**
	 * Per-project subset of `cliFiles` when auto-pick filtered cli files to
	 * specific projects. When absent or missing for a given project, the full
	 * `cliFiles` array is used (back-compat for `--project` and no-positional
	 * flows).
	 */
	filesByProject?: ReadonlyMap<string, Array<string>>;
	projects: Array<ResolvedProjectConfig>;
	rootConfig: ResolvedConfig;
}

interface SelectedProjects {
	filesByProject?: ReadonlyMap<string, Array<string>>;
	projects: Array<ResolvedProjectConfig>;
}

interface TypecheckOnlyArguments {
	cliFiles: Array<string> | undefined;
	cliTypecheck: TypecheckCliOptions;
	filesByProject?: ReadonlyMap<string, Array<string>>;
	projects: Array<ResolvedProjectConfig>;
	rootConfig: ResolvedConfig;
	timing: TimingCollector;
}

/**
 * `jest.config` stub mounts for a place build: one `$path` named-child per rojo
 * mount that lacks a user-authored config on disk, pointing at the cache stub.
 * Shared by the open-cloud place build and `prepareArtifacts`'s Clean Place.
 */
export function collectStubMounts(
	projects: Array<ResolvedProjectConfig>,
	rootDirectory: string,
	cacheRoot: string,
): Array<StubMount> {
	// Per-mount FS check decides whether to inject. A TS string-entry may or may
	// not have a compiled `.luau` at the mount yet — trust the filesystem rather
	// than the entry shape.
	const stubMounts: Array<StubMount> = [];
	for (const project of projects) {
		for (const mount of project.rojoMounts) {
			const sourceMount = path.resolve(rootDirectory, mount.fsPath);
			if (hasUserAuthoredConfig(sourceMount)) {
				continue;
			}

			stubMounts.push({
				absStubPath: path.resolve(cacheRoot, mount.fsPath, STUB_FILENAME),
				dataModelPath: mount.dataModelPath,
			});
		}
	}

	return stubMounts;
}

export function loadRojoTree(config: ResolvedConfig): RojoTreeNode {
	const rojoPath = path.resolve(config.rootDir, config.rojoProject ?? DEFAULT_ROJO_PROJECT);
	const content = fs.readFileSync(rojoPath, "utf8");
	const parsed = JSON.parse(content);
	const validated = rojoProjectSchema(parsed);
	if (validated instanceof type.errors) {
		throw new Error(`Invalid Rojo project: ${validated.summary}`);
	}

	return resolveNestedProjects(validated.tree, path.dirname(rojoPath));
}

/**
 * Multi-project execution core: stub generation, place build, discovery, and
 * job dispatch over a set of already-resolved projects. Shared by the
 * `projects:`-configured path (`runMultiProject`) and the no-`projects` collapse
 * (`run.ts` synthesizes one project from the config's luau roots and calls this),
 * so both paths get identical per-root `jest.config` stub injection, place
 * rebuild, coverage, and result shaping.
 */
export async function runResolvedProjects(
	allProjects: Array<ResolvedProjectConfig>,
	rootConfig: ResolvedConfig,
	cli: RunOptions["cli"],
	timing: TimingCollector,
): Promise<MultiRunResult> {
	const cliTypecheck: TypecheckCliOptions = {
		enabled: cli.typecheck,
		only: cli.typecheckOnly,
		tsconfig: cli.typecheckTsconfig,
	};

	timing.profile("resolveSetupFilePaths", () => {
		resolveAllSetupFilePaths(allProjects.map((project) => project.config));
	});

	const { filesByProject, projects } = timing.profile("selectProjects", () => {
		return selectProjects(allProjects, cli.project, cli.files, rootConfig.rootDir);
	});

	// Pure-local tsgo short-circuit. When every selected project runs
	// Type-Tests-only (`--typecheckOnly`, or each project's own
	// `test.typecheck.only`), no runtime jobs are possible — so skip the backend,
	// the place build, and coverage entirely and run only the host-side tsgo
	// pass. This restores parity with single and workspace mode, which both
	// already avoid Open Cloud for type-only runs (single never resolves a
	// backend when there are no runtime files; workspace short-circuits on an
	// empty pending set). Without this, multi mode resolves a backend and builds
	// a Rojo place even when nothing runs on Roblox.
	const isTypecheckOnlyRun = projects.every((project) => {
		return resolveTypecheckConfig({
			cli: cliTypecheck,
			project: project.typecheck,
			root: rootConfig.typecheck,
		}).only;
	});
	if (isTypecheckOnlyRun) {
		return runMultiTypecheckOnly({
			cliFiles: cli.files,
			cliTypecheck,
			filesByProject,
			projects,
			rootConfig,
			timing,
		});
	}

	// Stubs land in `.jest-roblox/cache/` instead of the user's source
	// tree. Open-cloud builds the place from a synthesizer-produced
	// project that mounts those cache stubs via `$path` named-children;
	// studio skips the place build entirely and the plugin's Run Mode
	// runner materializes `jest.config` ModuleScripts in DataModel from
	// the JSON configs.
	const cacheRoot = path.resolve(rootConfig.rootDir, ".jest-roblox", "cache");

	// Pre-flight cleanup mirrors workspace behaviour: upgraders coming
	// from a pre-refactor version may have marker-bearing leftover stubs
	// in their source tree. The synthesizer's `assertNoSourceCollision`
	// and the plugin's runtime `FindFirstChild` check would both block
	// the run otherwise.
	const cleaned = timing.profile("cleanLeftoverStubs", () => {
		return cleanLeftoverStubs(projects, rootConfig.rootDir);
	});
	if (cleaned.length > 0) {
		process.stderr.write(
			`jest-roblox: cleaned ${String(cleaned.length)} leftover stub(s):\n${cleaned
				.map((stubPath) => `  ${stubPath}\n`)
				.join("")}`,
		);
	}

	timing.profile("generateProjectStubs", () => {
		generateProjectStubs(projects, rootConfig.rootDir, cacheRoot);
	});

	const { coverageArtifacts, effectiveConfig, preCoverageMs } = timing.profile(
		"prepareCoverage",
		() => prepareMultiProjectCoverage(rootConfig, projects, cacheRoot),
	);
	const backend = await timing.profileAsync("resolveBackend", async () => {
		return resolveBackend(cli, effectiveConfig);
	});
	const parallel = effectiveParallelForBackend(effectiveConfig.parallel, backend);

	if (!rootConfig.collectCoverage && backend.kind === "open-cloud") {
		timing.profile("buildOpenCloudPlace", () => {
			buildOpenCloudPlace(rootConfig, projects, cacheRoot);
		});
	}

	const { pendingJobs, typeTestEntries } = timing.profile("collectPendingJobs", () => {
		return collectPendingJobs({
			cliFiles: cli.files,
			cliTypecheck,
			effectivePlaceFile: effectiveConfig.placeFile,
			filesByProject,
			projects,
			rootConfig,
		});
	});

	if (pendingJobs.length > 0) {
		emitRunHeader({
			collectCoverage: rootConfig.collectCoverage,
			color: rootConfig.color,
			formatters: rootConfig.formatters,
			rootDir: rootConfig.rootDir,
			silent: rootConfig.silent,
			verbose: rootConfig.verbose,
			version: VERSION,
		});
	}

	// One tsgo pass per distinct `(tsconfig, cwd)` group: projects sharing a
	// tsconfig collapse to a single compilation, projects with distinct
	// tsconfigs are each checked against their own, and diagnostics are
	// attributed back to each project's tests via the merged result.
	// `ignoreSourceErrors` is a run-wide reporting policy, resolved from root
	// `test.typecheck` + CLI (the per-project tsconfig drives grouping, not the
	// source-error decision), then applied to every group's tsgo pass.
	//
	// The pass runs concurrently with `runJobs` so the local CPU-bound tsgo
	// work overlaps the network-bound Open Cloud upload/poll.
	const rootTypecheck = resolveTypecheckConfig({ cli: cliTypecheck, root: rootConfig.typecheck });
	const [projectResults, typecheckPass] = await Promise.all([
		runJobs(backend, pendingJobs, parallel, timing),
		// Run-wide policy: every group's tsgo pass uses the root
		// `ignoreSourceErrors`/`spawnTimeout` (the per-project tsconfig drives
		// grouping, not the source-error decision).
		runTypecheckPass(typeTestEntries, async (group) => {
			return runTypecheck({
				files: group.files,
				ignoreSourceErrors: rootTypecheck.ignoreSourceErrors,
				rootDir: group.cwd,
				spawnTimeout: rootTypecheck.spawnTimeout,
				timeout: rootConfig.timeout,
				tsconfig: group.tsconfig,
			});
		}),
	]);
	// Record the tsgo span at root once both branches settle — the collector's
	// LIFO stack is not concurrency-safe, so the pass must not `profile` while
	// `runJobs` is open. `elapsedMs` is 0 (and skipped) when there are no Type
	// Tests; otherwise the sibling span makes the overlap visible (host TOTAL
	// sums the two while wall-clock is the longer of them).
	if (typecheckPass.elapsedMs > 0) {
		timing.record("runTypecheck", typecheckPass.elapsedMs);
	}

	const { result: typecheckResult } = typecheckPass;

	if (projectResults.length === 0 && typecheckResult === undefined) {
		if (rootConfig.passWithNoTests) {
			return {
				coverageArtifacts,
				merged: {},
				mode: "multi",
				preCoverageMs,
				projectResults: [],
			};
		}

		return {
			coverageArtifacts,
			merged: {},
			mode: "multi",
			preCoverageMs,
			projectResults: [],
			validationExitCode: 2,
			validationMessage: "No test files found in any project\n",
		};
	}

	const collectCoverageFrom = rootConfig.collectCoverage
		? (rootConfig.collectCoverageFrom ?? deriveCoverageFromIncludes(projects))
		: rootConfig.collectCoverageFrom;

	const coverageDisplayFilter = buildMultiDisplayFilter({
		cliFiles: cli.files,
		matchedRuntimeFiles: pendingJobs.flatMap((job) => job.runtimeFiles),
		projectNames: cli.project,
		projects,
		rootDir: rootConfig.rootDir,
		testPathPattern: rootConfig.testPathPattern,
	});

	return {
		collectCoverageFrom,
		coverageArtifacts,
		coverageDisplayFilter,
		merged: mergeForMultiResult(projectResults),
		mode: "multi",
		preCoverageMs,
		projectResults,
		typecheckResult,
	};
}

export async function runMultiProject(options: MultiRunOptions): Promise<MultiRunResult> {
	const { cli, config: rootConfig, rawProjects } = options;
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;
	const rojoTree = timing.profile("loadRojoTree", () => loadRojoTree(rootConfig));

	const allProjects = await timing.profileAsync("resolveAllProjects", async () => {
		return resolveAllProjects(rawProjects, rootConfig, rojoTree, rootConfig.rootDir);
	});

	return runResolvedProjects(allProjects, rootConfig, cli, timing);
}

// Builds the agent text-table narrowing for a filtered multi run. Files named
// directly (positionals) win as source twins; a `--testPathPattern` twins the
// matched runtime files; a bare `--project` scopes the table to the selected
// projects' source roots (so the project's untested files still report 0%). A
// full run (none of these) returns undefined — the table keeps the full
// universe. Display-only: never reaches thresholds, totals, or lcov/html/json.
function buildMultiDisplayFilter(options: {
	cliFiles: Array<string> | undefined;
	matchedRuntimeFiles: Array<string>;
	projectNames: Array<string> | undefined;
	projects: Array<ResolvedProjectConfig>;
	rootDir: string;
	testPathPattern: string | undefined;
}): CoverageDisplayPredicate | undefined {
	const { cliFiles, matchedRuntimeFiles, projectNames, projects, rootDir, testPathPattern } =
		options;

	// Positionals name the files directly; twin the raw CLI args (not the
	// post-discovery set) so the table reflects exactly what the user typed. The
	// single-mode twin uses post-discovery `runtimeFiles` because there is no
	// auto-pick partitioning to preserve there.
	if (cliFiles !== undefined && cliFiles.length > 0) {
		return sourceTwinFilter(cliFiles, rootDir);
	}

	if (testPathPattern !== undefined) {
		return sourceTwinFilter(matchedRuntimeFiles, rootDir);
	}

	if (projectNames !== undefined) {
		const posixRootDirectory = normalizeWindowsPath(rootDir);
		const roots = projects.flatMap((project) =>
			collectProjectRoots(project, posixRootDirectory),
		);
		// Projects whose `include` is a bare glob (no static directory prefix)
		// yield no roots, so there is no containment boundary to scope by. Fall
		// back to the full universe rather than an empty table — the user passed
		// `--project`, so showing every file beats showing nothing.
		return roots.length > 0 ? projectRootFilter(roots) : undefined;
	}

	return undefined;
}

function buildOpenCloudPlace(
	rootConfig: ResolvedConfig,
	projects: Array<ResolvedProjectConfig>,
	cacheRoot: string,
): void {
	const userRojoProjectPath = path.resolve(
		rootConfig.rootDir,
		rootConfig.rojoProject ?? DEFAULT_ROJO_PROJECT,
	);
	const placeFilePath = resolvePlaceFilePath(rootConfig);

	buildPlace({
		packages: [
			{
				name: "multi-project",
				packageDirectory: rootConfig.rootDir,
				rojoProjectPath: userRojoProjectPath,
				stubMounts: collectStubMounts(projects, rootConfig.rootDir, cacheRoot),
			},
		],
		placeFile: placeFilePath,
		projectFile: path.resolve(cacheRoot, "synth.project.json"),
		wrap: false,
	});
}

// Same per-mount FS filter as the synthesizer's stubMounts loop: drop mounts
// where a user-authored `jest.config.luau` already exists. The runtime injector
// mustn't parent a duplicate `jest.config` over a Rojo-synced user file.
function collectRuntimeInjectionPaths(
	project: ResolvedProjectConfig,
	rootDirectory: string,
): Array<string> {
	const runtimeInjectionPaths: Array<string> = [];
	for (const mount of project.rojoMounts) {
		const sourceMount = path.resolve(rootDirectory, mount.fsPath);
		if (hasUserAuthoredConfig(sourceMount)) {
			continue;
		}

		runtimeInjectionPaths.push(mount.dataModelPath);
	}

	return runtimeInjectionPaths;
}

function collectPendingJobs(arguments_: CollectPendingJobsArguments): {
	pendingJobs: Array<PendingJob>;
	typeTestEntries: Array<TypecheckGroupEntry>;
} {
	const { cliFiles, cliTypecheck, effectivePlaceFile, filesByProject, projects, rootConfig } =
		arguments_;
	const pendingJobs: Array<PendingJob> = [];
	const typeTestEntries: Array<TypecheckGroupEntry> = [];

	for (const project of projects) {
		// When auto-pick produced a per-project file subset, only feed those
		// files into discovery / narrowing for this project. Otherwise (no
		// positional files, or explicit `--project`), fall back to the full
		// cli.files list.
		const projectCliFiles = filesByProject?.get(project.displayName) ?? cliFiles;

		const typecheck = resolveTypecheckConfig({
			cli: cliTypecheck,
			project: project.typecheck,
			root: rootConfig.typecheck,
		});

		// Type Tests are discovered by `-d` globs derived from the Runtime
		// `include` (or an explicit `test.typecheck.include`). These stay in the
		// local discovery `testMatch` only — never folded into `project.include`
		// — so coverage-source derivation (which reads `project.include`) never
		// sees a `-d` glob.
		const typecheckInclude = typecheck.enabled
			? (typecheck.include ?? deriveTypecheckInclude(project.include))
			: [];
		const discoveryConfig: ResolvedConfig = {
			...project.config,
			placeFile: effectivePlaceFile,
			projects: project.projects,
			testMatch: [...project.include, ...typecheckInclude],
		};

		const discovery = discoverTestFiles(discoveryConfig, projectCliFiles);
		const classified = classifyTestFiles(discovery.files, typecheck);
		// `exclude` globs only match the relative paths glob-discovery returns;
		// explicit positional files come back absolute and are user-chosen, so
		// they bypass `exclude` — mirroring how `testPathIgnorePatterns` is
		// already skipped for positionals in `discoverTestFiles`. Runtime files
		// use the project's `exclude`; type tests use `test.typecheck.exclude`.
		const isPositional = (projectCliFiles?.length ?? 0) > 0;
		const runtimeFiles = isPositional
			? classified.runtimeFiles
			: applyExcludes(classified.runtimeFiles, project.exclude);
		const typeTestFiles = isPositional
			? classified.typeTestFiles
			: applyExcludes(classified.typeTestFiles, typecheck.exclude);

		// Narrow by the per-project discovered files (not the raw positional/flag
		// input) so the Luau runner receives an Instance-namespace basename
		// pattern. A bare project run (no positionals, no `--testPathPattern`)
		// keeps `testPathPattern` undefined so Jest-on-Roblox runs all testMatch.
		const filterActive = isPositional || discoveryConfig.testPathPattern !== undefined;
		const projConfig: ResolvedConfig = narrowForLuauRun(
			{ ...discoveryConfig, testMatch: project.testMatch },
			runtimeFiles,
			filterActive,
		);

		// Each project carries its own effective `(tsconfig, cwd)` into the type
		// pass; `groupTypecheckByTsconfig` collapses projects sharing one and
		// checks distinct tsconfigs separately. cwd is always the workspace root
		// in projects mode (all projects build from one tree).
		if (typeTestFiles.length > 0) {
			typeTestEntries.push({
				cwd: rootConfig.rootDir,
				files: typeTestFiles,
				...(typecheck.tsconfig !== undefined ? { tsconfig: typecheck.tsconfig } : {}),
			});
		}

		if (runtimeFiles.length === 0) {
			continue;
		}

		pendingJobs.push({
			config: projConfig,
			displayColor: project.displayColor,
			displayName: project.displayName,
			runtimeFiles,
			runtimeInjectionPaths: collectRuntimeInjectionPaths(project, rootConfig.rootDir),
		});
	}

	return { pendingJobs, typeTestEntries };
}

// Runs the host-side Type Test pass alone — no backend, no place build, no
// coverage. Reached only when `runMultiProject` proves the run is type-only.
// Discovery still goes through the shared `collectPendingJobs` (so `-d`
// derivation, per-project tsconfig grouping, and excludes match the runtime
// path); the runtime `pendingJobs` it returns are necessarily empty here and
// ignored.
async function runMultiTypecheckOnly(arguments_: TypecheckOnlyArguments): Promise<MultiRunResult> {
	const { cliFiles, cliTypecheck, filesByProject, projects, rootConfig, timing } = arguments_;

	const { typeTestEntries } = timing.profile("collectPendingJobs", () => {
		return collectPendingJobs({
			cliFiles,
			cliTypecheck,
			// No place is built on a type-only run; the runtime place file is
			// unused because the (empty) `pendingJobs` are discarded.
			effectivePlaceFile: rootConfig.placeFile,
			filesByProject,
			projects,
			rootConfig,
		});
	});

	if (typeTestEntries.length === 0) {
		if (rootConfig.passWithNoTests) {
			return { merged: {}, mode: "multi", preCoverageMs: 0, projectResults: [] };
		}

		return {
			merged: {},
			mode: "multi",
			preCoverageMs: 0,
			projectResults: [],
			validationExitCode: 2,
			validationMessage: "No test files found in any project\n",
		};
	}

	// No run header: a type-only run drives no Roblox jobs, matching single mode
	// (which emits the banner only from the runtime path) and the prior multi
	// behaviour (the header was gated on a non-empty runtime job set).
	const rootTypecheck = resolveTypecheckConfig({ cli: cliTypecheck, root: rootConfig.typecheck });
	const typecheckPass = await runTypecheckPass(typeTestEntries, async (group) => {
		return runTypecheck({
			files: group.files,
			ignoreSourceErrors: rootTypecheck.ignoreSourceErrors,
			rootDir: group.cwd,
			spawnTimeout: rootTypecheck.spawnTimeout,
			tsconfig: group.tsconfig,
		});
	});
	timing.record("runTypecheck", typecheckPass.elapsedMs);

	return {
		merged: {},
		mode: "multi",
		preCoverageMs: 0,
		projectResults: [],
		typecheckResult: typecheckPass.result,
	};
}

async function runJobs(
	backend: Backend,
	pendingJobs: Array<PendingJob>,
	parallel: ParallelOption,
	timing: TimingCollector,
): Promise<Array<ProjectResult>> {
	if (pendingJobs.length === 0) {
		await backend.close?.();
		return [];
	}

	let runResult;
	try {
		runResult = await timing.profileAsync("runProjects", async () => {
			return runProjects({
				backend,
				deferFormatting: true,
				parallel,
				projects: pendingJobs.map((pending) => {
					return {
						config: pending.config,
						displayColor: pending.displayColor,
						displayName: pending.displayName,
						runtimeInjectionPaths: pending.runtimeInjectionPaths,
						testFiles: pending.runtimeFiles,
					};
				}),
				startTime: Date.now(),
				timing,
				version: VERSION,
			});
		});
	} finally {
		await backend.close?.();
	}

	return runResult.results.map((executeResult, index) => {
		// eslint-disable-next-line ts/no-non-null-assertion -- runProjects preserves order
		const pending = pendingJobs[index]!;
		return {
			displayColor: pending.displayColor,
			displayName: pending.displayName,
			result: executeResult,
		};
	});
}

function prepareMultiProjectCoverage(
	rootConfig: ResolvedConfig,
	projects: Array<ResolvedProjectConfig>,
	cacheRoot: string,
): {
	coverageArtifacts?: CoverageArtifacts;
	effectiveConfig: ResolvedConfig;
	preCoverageMs: number;
} {
	if (!rootConfig.collectCoverage) {
		return { effectiveConfig: rootConfig, preCoverageMs: 0 };
	}

	// Baked `jest.config` stubs are how a backend that can't inject at runtime
	// (open-cloud) gets each project's config into the place. studio-cli instead
	// drives the plugin's Run-mode runner, which materializes `jest.config`
	// ModuleScripts from the payload configs — so baking them here too would have
	// the runner collide with an already-present `jest.config` ("Structural
	// collision …"). Skip baking for studio-cli and let runtime injection be the
	// sole config source, mirroring its non-coverage Clean Place (which carries
	// no baked stubs either). `auto` never resolves to studio-cli, so the config
	// flag is the exact, probe-free signal.
	const bakeStubs = rootConfig.backend !== "studio-cli";

	const start = Date.now();
	const coverage = prepareCoverage(
		rootConfig,
		bakeStubs
			? (shadowDirectory) => {
					// Mirror cache stubs into the shadow tree. The source tree is
					// clean post-refactor (stubs land in `cacheRoot`, not
					// `rootDir`), so without this the coverage place would build
					// without any `jest.config` ModuleScripts.
					return syncStubsToShadowDirectory(projects, cacheRoot, shadowDirectory);
				}
			: undefined,
	);
	return {
		coverageArtifacts: toCoverageArtifacts(coverage, toBuildManifestProjects(projects)),
		effectiveConfig: { ...rootConfig, placeFile: coverage.placeFile },
		preCoverageMs: Date.now() - start,
	};
}

function effectiveParallelForBackend(
	parallel: ParallelOption,
	backend: { kind: string },
): ParallelOption {
	return backend.kind === "open-cloud" ? parallel : undefined;
}

function mergeForMultiResult(projectResults: Array<ProjectResult>): MultiProjectMerged {
	if (projectResults.length === 0) {
		return {};
	}

	let mergedCoverage: RawCoverageData | undefined;
	let mergedAttribution: AttributionResult | undefined;
	const mappers: Array<SourceMapper> = [];

	for (const { result } of projectResults) {
		if (result.coverageData !== undefined) {
			mergedCoverage = mergeRawCoverage(mergedCoverage, result.coverageData);
		}

		if (result.attribution !== undefined) {
			mergedAttribution =
				mergedAttribution === undefined
					? result.attribution
					: mergeAttribution(mergedAttribution, result.attribution);
		}

		if (result.sourceMapper !== undefined) {
			mappers.push(result.sourceMapper);
		}
	}

	const merged: MultiProjectMerged = {};
	if (mergedCoverage !== undefined) {
		merged.coverageData = mergedCoverage;
	}

	if (mergedAttribution !== undefined) {
		merged.attribution = mergedAttribution;
	}

	if (mappers.length > 0) {
		merged.sourceMapper = combineSourceMappers(mappers);
	}

	return merged;
}

function filterProjectsByName(
	projects: Array<ResolvedProjectConfig>,
	names: Array<string>,
): Array<ResolvedProjectConfig> {
	const available = new Set(projects.map((project) => project.displayName));
	const unknown = names.filter((name) => !available.has(name));
	if (unknown.length > 0) {
		throw new Error(
			`Unknown project name(s): ${unknown.join(", ")}. Available: ${[...available].join(", ")}`,
		);
	}

	const nameSet = new Set(names);
	return projects.filter((project) => nameSet.has(project.displayName));
}

function selectProjects(
	allProjects: Array<ResolvedProjectConfig>,
	projectNames: Array<string> | undefined,
	cliFiles: Array<string> | undefined,
	rootDirectory: string,
): SelectedProjects {
	if (projectNames !== undefined) {
		return { projects: filterProjectsByName(allProjects, projectNames) };
	}

	if (cliFiles !== undefined && cliFiles.length > 0) {
		const matches = filterProjectsByFiles(allProjects, cliFiles, rootDirectory);
		return {
			filesByProject: new Map(
				matches.map((match) => [match.project.displayName, match.matchingFiles]),
			),
			projects: matches.map((match) => match.project),
		};
	}

	return { projects: allProjects };
}
