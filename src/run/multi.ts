import { resolveNestedProjects } from "@isentinel/rojo-utils";

import { type } from "arktype";
import * as path from "node:path";

import type { Backend } from "../backends/interface.ts";
import { filterProjectsByFiles } from "../config/filter-projects-by-files.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import { assertKnownProjectNames } from "../config/projects.ts";
import type { TypecheckCliOptions } from "../config/resolve-typecheck-config.ts";
import { resolveTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ProjectEntry, ResolvedConfig } from "../config/schema.ts";
import { resolvePartialRun } from "../related/partial-run.ts";
import { resolveCodeRoots } from "../staging/code-roots.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import { rojoProjectSchema } from "../types/rojo.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { resolveAllSetupFilePaths } from "./discovery.ts";
import { resolveRunBackendAsync, runTestPlanAsync, runTypecheckPassAsync } from "./execution.ts";
import { buildMultiRunResult } from "./multi-result.ts";
import type { MultiRunResult, RunOptions } from "./run-types.ts";
import type { RunSeams } from "./seams.ts";
import { nodeRunSeams } from "./seams.ts";
import { stageRunAsync } from "./staging.ts";
import type { EmptyRunPolicy, RunDiscovery, TestPlan } from "./test-plan.ts";
import { bindTestPlanToPlace, buildTestPlan } from "./test-plan.ts";

const DEFAULT_ROJO_PROJECT = "default.project.json";
/**
 * Everything this run writes for itself, framed on `rootDir`. One Code Root
 * covers the lot: the generated `jest.config` stubs under `cache/`, and the
 * coverage shadow and its spine copies under `coverage/` — which hang off the
 * invocation directory, the same place a multi run is invoked from.
 */
const STAGING_DIRECTORY = ".jest-roblox";
/** Inputs of {@link runMultiProjectAsync}. */
export interface MultiRunOptions extends RunOptions {
	/** Project entries as the config declares them. */
	rawProjects: Array<ProjectEntry>;
}

/** Inputs of {@link runResolvedProjectsAsync}. */
export interface ResolvedProjectsRunInput extends ResolvedRunInput {
	/** Every resolved project, before `--project` or positional selection. */
	allProjects: Array<ResolvedProjectConfig>;
	/** Root config of the run. */
	rootConfig: ResolvedConfig;
}

/**
 * The run-wide inputs discovery and execution share, with the seam already
 * settled — resolved once at the entry point rather than re-defaulted at each
 * layer, so no stage below can reach the real disk by omitting it.
 */
interface ResolvedRunInput {
	cli: RunOptions["cli"];
	fileSystem: FileSystem;
	seams: RunSeams;
	timing: TimingCollector;
}

interface SelectedProjects {
	filesByProject?: ReadonlyMap<string, Array<string>> | undefined;
	projects: Array<ResolvedProjectConfig>;
}

interface SelectProjectsOptions {
	allProjects: Array<ResolvedProjectConfig>;
	cliFiles: Array<string> | undefined;
	projectNames: Array<string> | undefined;
	rootDirectory: string;
}

/**
 * Read and validate the Rojo project, then resolve its nested projects.
 *
 * @param config - Config whose `rootDir` and `rojoProject` locate the file.
 * @param fileSystem - File system to read from; defaults to Node's.
 * @returns The resolved Rojo tree.
 * @throws {Error} When the file does not match the Rojo project schema.
 */
export function loadRojoTree(
	config: ResolvedConfig,
	fileSystem: FileSystem = nodeFileSystem,
): RojoTreeNode {
	const rojoPath = path.resolve(config.rootDir, config.rojoProject ?? DEFAULT_ROJO_PROJECT);
	const content = fileSystem.readFileSync(rojoPath, "utf8");
	const parsed = JSON.parse(content);
	const validated = rojoProjectSchema(parsed);
	if (validated instanceof type.errors) {
		throw new Error(`Invalid Rojo project: ${validated.summary}`);
	}

	return resolveNestedProjects(
		{ rootDirectory: path.dirname(rojoPath), tree: validated.tree },
		fileSystem,
	);
}

/**
 * Multi-project execution core: staging, test-plan building, and execution over
 * a set of already-resolved projects. Shared by the `projects:`-configured path
 * (`runMultiProject`) and the no-`projects` collapse (`run.ts` synthesizes one
 * project from the config's luau roots and calls this), so both paths get
 * identical per-root `jest.config` stub injection, place rebuild, coverage, and
 * result shaping.
 *
 * @param input - Resolved projects, root config, CLI options, seams and profiler.
 * @param input.allProjects - Every resolved project.
 * @param input.cli - Parsed command-line options.
 * @param input.fileSystem - Where the run reads and writes.
 * @param input.rootConfig - Resolved config before per-project overrides.
 * @param input.seams - Seams the run reaches outside itself through.
 * @param input.timing - Profiler of the run.
 * @returns The multi-run result.
 */
export async function runResolvedProjectsAsync({
	allProjects,
	cli,
	fileSystem,
	rootConfig,
	seams,
	timing,
}: ResolvedProjectsRunInput): Promise<MultiRunResult> {
	const discovery = beginRun({ allProjects, cli, fileSystem, rootConfig, seams, timing });
	if (isTypecheckOnlyRun(discovery)) {
		return runMultiTypecheckOnlyAsync(discovery);
	}

	// Discovered before anything is resolved or written. A plan that selected
	// nothing stops the run here, so an empty one still costs no backend, no
	// instrumentation and no place — the invariant `TestPlan.emptiness`
	// states, now that staging comes after the backend rather than before it.
	// The jobs are aimed at a place below, once the run has built one.
	const plan = buildTestPlan(discovery);
	if (plan.emptiness !== undefined) {
		return emptyMultiResult(plan.emptiness);
	}

	// Resolved before staging, because staging is what decides whether the
	// place holds this run's code, and only the backend can answer that.
	// Against the root config rather than `staged.effectiveConfig`: the two
	// differ only in `placeFile`, which `resolveBackend` never reads, and the
	// effective one does not exist yet.
	const backend = await resolveRunBackendAsync({ cli, config: rootConfig, seams, timing });
	try {
		return await stageAndExecuteAsync({ backend, cli, discovery, plan, rootConfig });
	} finally {
		// Widened to cover staging: with the backend resolved first, a rojo
		// failure there would otherwise leave an open one behind.
		await backend.closeAsync?.();
	}
}

/**
 * Load the Rojo tree, resolve the configured projects and run them.
 *
 * @param options - Run options and the raw project entries.
 * @returns The multi-run result.
 */
export async function runMultiProjectAsync(options: MultiRunOptions): Promise<MultiRunResult> {
	const { cli, config: rootConfig, fileSystem = nodeFileSystem, rawProjects } = options;
	const seams = { ...nodeRunSeams(), ...options.seams };
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;
	const rojoTree = timing.profile("loadRojoTree", () => loadRojoTree(rootConfig, fileSystem));

	const allProjects = await timing.profileAsync("resolveAllProjects", async () => {
		return seams.resolveAllProjects({
			childProcess: seams.childProcess,
			cwd: rootConfig.rootDir,
			entries: rawProjects,
			fileSystem,
			rojoTree,
			rootConfig,
			tsconfigReader: seams.tsconfigReader,
		});
	});

	return runResolvedProjectsAsync({ allProjects, cli, fileSystem, rootConfig, seams, timing });
}

/**
 * The Code Roots this run's Code Bundle is split against, or none when it ships
 * the whole place.
 *
 * @param options - Backend, discovery and root config.
 * @param options.backend - Backend the run dispatches to.
 * @param options.discovery - Discovered projects, file system and seams.
 * @param options.rootConfig - Config whose `rootDir` holds the staging directory.
 * @returns The Code Roots, or `undefined` for a whole place.
 */
function resolveRunCodeRoots({
	backend,
	discovery,
	rootConfig,
}: {
	backend: Backend;
	discovery: RunDiscovery;
	rootConfig: ResolvedConfig;
}): Array<PosixRoot> | undefined {
	return resolveCodeRoots({
		backendKind: backend.kind,
		configs: discovery.projects.map((project) => project.config),
		fileSystem: discovery.fileSystem,
		stagingDirectory: path.resolve(rootConfig.rootDir, STAGING_DIRECTORY),
		tsconfigReader: discovery.seams.tsconfigReader,
	});
}

/**
 * Put the run's inputs on disk against a backend already in hand, then dispatch
 * against it.
 *
 * @param options - Backend, CLI options, discovery, plan and root config.
 * @param options.backend - Backend already resolved for the run.
 * @param options.cli - Parsed command-line options.
 * @param options.discovery - Discovered projects, file system, seams and profiler.
 * @param options.plan - Plan built before staging.
 * @param options.rootConfig - Resolved config before per-project overrides.
 * @returns The multi-run result.
 */
async function stageAndExecuteAsync({
	backend,
	cli,
	discovery,
	plan,
	rootConfig,
}: {
	backend: Backend;
	cli: RunOptions["cli"];
	discovery: RunDiscovery;
	plan: TestPlan;
	rootConfig: ResolvedConfig;
}): Promise<MultiRunResult> {
	const { fileSystem, seams, timing } = discovery;
	// Resolved here rather than carried back out of staging: the coverage build
	// inside it and the non-coverage build after it are two halves of one
	// decision, so the decision is made once, above both.
	const codeRoots = resolveRunCodeRoots({ backend, discovery, rootConfig });
	const staged = await stageRunAsync({
		backendKind: backend.kind,
		codeRoots,
		fileSystem,
		projects: plan.projects,
		rootConfig,
		seams,
		timing,
	});
	// Only now does the run know where the jobs execute: a coverage run built
	// an instrumented place of its own while this plan was already in hand.
	const dispatchPlan = bindTestPlanToPlace(plan, staged.effectiveConfig.placeFile);
	const outcome = await runTestPlanAsync({
		backend,
		cli,
		codeRoots,
		discovery,
		plan: dispatchPlan,
		staged,
	});
	return buildMultiRunResult({ cli, discovery, outcome, plan: dispatchPlan, staged });
}

function filterProjectsByName(
	projects: Array<ResolvedProjectConfig>,
	names: Array<string>,
): Array<ResolvedProjectConfig> {
	const available = new Set(projects.map((project) => project.displayName));
	assertKnownProjectNames(names, available);

	const nameSet = new Set(names);
	return projects.filter((project) => nameSet.has(project.displayName));
}

function selectProjects({
	allProjects,
	cliFiles,
	projectNames,
	rootDirectory,
}: SelectProjectsOptions): SelectedProjects {
	if (projectNames !== undefined) {
		return { projects: filterProjectsByName(allProjects, projectNames) };
	}

	if (cliFiles !== undefined && cliFiles.length > 0) {
		const matches = filterProjectsByFiles({
			files: cliFiles,
			projects: allProjects,
			rootDirectory,
		});
		return {
			filesByProject: new Map(
				matches.map((match) => [match.project.displayName, match.matchingFiles]),
			),
			projects: matches.map((match) => match.project),
		};
	}

	return { projects: allProjects };
}

/**
 * Resolve the run's shared discovery inputs: the CLI typecheck layer, the
 * setup-file rewrite, and the `--project`/positional project selection.
 *
 * @param input - Resolved projects, root config, CLI options, seams and profiler.
 * @param input.allProjects - Every resolved project; setup paths resolve in place.
 * @param input.cli - Parsed command-line options.
 * @param input.rootConfig - Resolved config before per-project overrides.
 * @returns The discovery inputs of the selected projects.
 */
function beginRun({
	allProjects,
	cli,
	rootConfig,
	...run
}: ResolvedProjectsRunInput): RunDiscovery {
	const cliTypecheck: TypecheckCliOptions = {
		enabled: cli.typecheck,
		only: cli.typecheckOnly,
		tsconfig: cli.typecheckTsconfig,
	};

	// Rewrites setup specifiers to DataModel paths in place. Must precede
	// staging: `toBuildManifestProjects` bakes the resolved paths into the Build
	// Manifest the coverage place is published with.
	run.timing.profile("resolveSetupFilePaths", () => {
		resolveAllSetupFilePaths(
			allProjects.map((project) => project.config),
			run.seams.createSetupResolver,
		);
	});

	const { filesByProject, projects } = run.timing.profile("selectProjects", () => {
		return selectProjects({
			allProjects,
			cliFiles: cli.files,
			projectNames: cli.project,
			rootDirectory: rootConfig.rootDir,
		});
	});
	return {
		...run,
		cliFiles: cli.files,
		cliTypecheck,
		filesByProject,
		partialRun: resolvePartialRun({ ...run, cli, rootDirectory: rootConfig.rootDir }),
		projects,
		rootConfig,
	};
}

/**
 * Pure-local tsgo short-circuit. When every selected project runs
 * Type-Tests-only (`--typecheckOnly`, or each project's own
 * `test.typecheck.only`), no runtime jobs are possible — so the run skips the
 * backend, the place build, and coverage entirely. This is the cross-mode
 * `--typecheckOnly` invariant: no mode resolves a backend for a type-only run,
 * and the collapse path does not even require a Rojo project on disk.
 *
 * @param discovery - Selected projects, root config and CLI typecheck options.
 * @param discovery.cliTypecheck - Typecheck options from the CLI.
 * @param discovery.projects - Selected projects.
 * @param discovery.rootConfig - Resolved config before per-project overrides.
 * @returns `true` when every selected project is Type-Tests-only.
 */
function isTypecheckOnlyRun({ cliTypecheck, projects, rootConfig }: RunDiscovery): boolean {
	return projects.every((project) => {
		return resolveTypecheckConfig({
			cli: cliTypecheck,
			project: project.typecheck,
			root: rootConfig.typecheck,
		}).only;
	});
}

/**
 * What a run that selected nothing reports.
 *
 * No coverage and no staging time, because a run that stops on an empty plan
 * has done neither: the plan is built before the backend so that nothing is
 * resolved, instrumented or written for a run with no tests to run.
 *
 * @param emptiness - Exit code and notice of the empty run.
 * @returns A multi-run result with no projects and zero timings.
 */
function emptyMultiResult(emptiness: EmptyRunPolicy): MultiRunResult {
	return {
		coverageMs: 0,
		merged: {},
		mode: "multi",
		projectResults: [],
		stagingMs: 0,
		...emptiness,
	};
}

/**
 * Runs the host-side Type Test pass alone — no staging, no backend, no place
 * build, no coverage. Discovery still goes through the shared `buildTestPlan`
 * (so `-d` derivation, per-project tsconfig grouping, and excludes match the
 * runtime path); the runtime jobs it returns are necessarily empty here.
 *
 * No run header either: a type-only run drives no Roblox jobs, matching
 * workspace mode and the prior behaviour (the header was gated on a non-empty
 * runtime job set).
 *
 * @param discovery - Selected projects, root config, seams and profiler.
 * @returns A multi-run result with only the Type Test result.
 */
async function runMultiTypecheckOnlyAsync(discovery: RunDiscovery): Promise<MultiRunResult> {
	const plan = buildTestPlan(discovery);
	if (plan.emptiness !== undefined) {
		return emptyMultiResult(plan.emptiness);
	}

	const typecheck = await runTypecheckPassAsync({
		cliTypecheck: discovery.cliTypecheck,
		entries: plan.typeTestEntries,
		rootConfig: discovery.rootConfig,
		runTypecheck: discovery.seams.runTypecheck,
	});
	discovery.timing.record("runTypecheck", typecheck.elapsedMs);
	return { ...emptyMultiResult({}), typecheckResult: typecheck.result };
}
