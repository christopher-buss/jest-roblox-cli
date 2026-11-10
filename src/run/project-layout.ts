import process from "node:process";

import type { Backend } from "../backends/dispatch-request.ts";
import { pickRunSettings } from "../backends/interface.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { TypecheckCliOptions } from "../config/resolve-typecheck-config.ts";
import {
	resolveTypecheckConfig,
	toTypecheckCliOptions,
} from "../config/resolve-typecheck-config.ts";
import type { CliOptions, ResolvedConfig } from "../config/resolved-config.ts";
import { withRojoProject } from "../config/rojo-project.ts";
import { selectProjectScopes } from "../discovery/project-selector.ts";
import { dispatchJobsAsync } from "../executor/dispatch-jobs.ts";
import type { RunProgress } from "../progress/run-progress.ts";
import { resolvePartialRun } from "../related/partial-run.ts";
import type { ProjectResult, RunResult } from "../results/run-result-types.ts";
import { runProjectPreflight } from "../staging/preflight.ts";
import { stubCacheRoot } from "../staging/stage-stubs.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import { runPolicyTypecheckPassAsync } from "../typecheck/typecheck-groups.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { buildPlaceForBackendAsync } from "./execution.ts";
import { buildMultiRunResult } from "./multi-result.ts";
import {
	type FinishedRun,
	type RunLayout,
	runPipelineAsync,
	type RunRefusal,
	type RunUnits,
	type StagedInputs,
	type TestSelection,
	type TypecheckPass,
} from "./pipeline.ts";
import { buildProjectRunPolicy } from "./project-run-policy.ts";
import type { RunDiscovery, TestPlan } from "./run-plan.ts";
import { buildTestPlan } from "./run-plan.ts";
import type { RunSeams } from "./seams.ts";
import { resolveRunProjectsAsync } from "./single-projects.ts";
import type { StagedRun } from "./staging.ts";
import { stageRunAsync } from "./staging.ts";

/** Inputs of {@link createProjectLayout}. */
export interface ProjectLayoutInput {
	/** Parsed command-line options. */
	cli: CliOptions;
	/** Invocation directory; defaults to the process directory. */
	cwd?: string;
	/** Where the run reads and writes. */
	fileSystem: FileSystem;
	/** Stage reporter of the run. */
	progress: RunProgress;
	/** Config with the CLI options merged in. */
	rootConfig: ResolvedConfig;
	/** Seams the run reaches outside itself through. */
	seams: RunSeams;
	/** Profiler of the run. */
	timing: TimingCollector;
}

interface ProjectUnits extends RunUnits {
	allProjects: Array<ResolvedProjectConfig>;
}

interface ProjectSelection extends TestSelection {
	discovery: RunDiscovery;
	plan: TestPlan;
}

interface ProjectStaging {
	placeBuildMs: number;
	staged: StagedRun;
}

interface ProjectLayoutTypes {
	dispatched: Array<ProjectResult>;
	selection: ProjectSelection;
	staged: ProjectStaging;
	typecheck: TypecheckPass;
	units: ProjectUnits;
}

interface ProjectLayoutContext extends ProjectLayoutInput {
	cliTypecheck: TypecheckCliOptions;
}

interface BeginRunInput extends ProjectLayoutContext {
	allProjects: Array<ResolvedProjectConfig>;
}

interface SelectedProjects {
	filesByProject?: ReadonlyMap<string, Array<string>> | undefined;
	projects: Array<ResolvedProjectConfig>;
}

interface SelectProjectsOptions {
	allProjects: Array<ResolvedProjectConfig>;
	cliFiles: Array<string> | undefined;
	fileBase: string;
	projectNames: Array<string> | undefined;
	rootDirectory: string;
}

/**
 * Run the project layout through the shared pipeline.
 * @param input - Layout inputs.
 * @returns The run result.
 */
export async function runProjectLayoutAsync(input: ProjectLayoutInput): Promise<RunResult> {
	return runPipelineAsync(createProjectLayout(input), input);
}

async function typecheckProjectsAsync(
	{ cliTypecheck, rootConfig, seams }: ProjectLayoutContext,
	plan: TestPlan,
): Promise<TypecheckPass> {
	const { typecheck: policy } = buildProjectRunPolicy({ cliTypecheck, rootConfig });
	return {
		outcome: await runPolicyTypecheckPassAsync({
			entries: plan.typeTestEntries,
			policyByDirectory: new Map([[rootConfig.rootDir, policy]]),
			runTypecheck: seams.runTypecheck,
		}),
	};
}

function buildProjectResult(
	{ cli, seams }: ProjectLayoutContext,
	{ dispatched, selection, staged, typecheck }: FinishedRun<ProjectLayoutTypes>,
): RunResult {
	return buildMultiRunResult({
		cli,
		discovery: selection.discovery,
		outcome: {
			placeBuildMs: staged.placeBuildMs,
			projectResults: dispatched,
			typecheck: typecheck.outcome,
		},
		plan: selection.plan,
		seams,
		staged: staged.staged,
	});
}

async function dispatchProjectJobsAsync(
	{ fileSystem, progress, seams, timing }: ProjectLayoutContext,
	{
		backend,
		plan,
		staged: { staged },
	}: { backend: Backend; plan: TestPlan; staged: ProjectStaging },
): Promise<Array<ProjectResult>> {
	const { effectiveConfig } = staged;
	const { jobs } = plan;
	const dispatched = await dispatchJobsAsync({
		backend,
		dispatch: buildProjectRunPolicy({ cliTypecheck: {}, rootConfig: effectiveConfig }).dispatch,
		fileSystem,
		jobs,
		progress,
		runProjects: seams.runProjects,
		runSettings: pickRunSettings(effectiveConfig),
		timing,
		tsconfigCache: plan.tsconfigCache,
		tsconfigReader: seams.tsconfigReader,
	});
	return dispatched.results.map((result) => {
		// oxlint-disable-next-line typescript/no-non-null-assertion -- the executor checked every index
		const job = jobs[result.jobIndex]!;
		return { displayColor: job.displayColor, displayName: job.displayName, result };
	});
}

async function resolveProjectUnitsAsync(
	context: ProjectLayoutContext,
): Promise<ProjectUnits | RunRefusal> {
	const { cliTypecheck, fileSystem, rootConfig } = context;
	const typecheck = resolveTypecheckConfig({ cli: cliTypecheck, root: rootConfig.typecheck });
	if (!typecheck.only && !runProjectPreflight(rootConfig, fileSystem)) {
		return {
			refused: { coverageMs: 0, projectResults: [], stagingMs: 0, validationExitCode: 2 },
		};
	}

	return {
		allProjects: await resolveRunProjectsAsync(context),
		header: {
			color: rootConfig.color,
			formatters: rootConfig.formatters,
			rootDir: rootConfig.rootDir,
			silent: rootConfig.silent,
			verbose: rootConfig.verbose,
		},
	};
}

function selectProjects({
	allProjects,
	cliFiles,
	fileBase,
	projectNames,
	rootDirectory,
}: SelectProjectsOptions): SelectedProjects {
	const selected = selectProjectScopes({
		fileBase,
		files: cliFiles,
		names: projectNames,
		scopes: allProjects.map((project) => ({ project, rootDirectory })),
	});
	return {
		filesByProject: new Map(
			selected.flatMap(({ files, scope }) => {
				return files === undefined ? [] : [[scope.project.displayName, files]];
			}),
		),
		projects: selected.map(({ scope }) => scope.project),
	};
}

function beginRun({
	allProjects,
	cli,
	cliTypecheck,
	cwd,
	fileSystem,
	progress,
	rootConfig,
	seams,
	timing,
}: BeginRunInput): RunDiscovery {
	const run = { fileSystem, progress, seams, timing };
	const { filesByProject, projects } = run.timing.profile("selectProjects", () => {
		return selectProjects({
			allProjects,
			cliFiles: cli.files,
			fileBase: cwd ?? process.cwd(),
			projectNames: cli.project,
			rootDirectory: rootConfig.rootDir,
		});
	});
	return {
		...run,
		cliFiles: cli.files,
		cliTypecheck,
		filesByProject,
		partialRun: resolvePartialRun({ cli, rootDirectory: rootConfig.rootDir, seams, timing }),
		projects,
		rootConfig,
	};
}

function selectProjectTests(
	context: ProjectLayoutContext,
	allProjects: Array<ResolvedProjectConfig>,
): ProjectSelection {
	const discovery = beginRun({ ...context, allProjects });
	const plan = buildTestPlan(discovery);
	return {
		discovery,
		emptiness: plan.emptiness,
		plan,
		runtimeJobCount: plan.jobs.length,
		typeTestEntries: plan.typeTestEntries,
	};
}

async function stageProjectsAsync(
	{ fileSystem, rootConfig, seams, timing }: ProjectLayoutContext,
	{ backend, selection: { discovery, plan } }: { backend: Backend; selection: ProjectSelection },
): Promise<ProjectStaging & StagedInputs> {
	const staged = await stageRunAsync({
		fileSystem,
		projects: plan.projects,
		rootConfig,
		seams,
		timing,
	});
	const placeBuild = await buildPlaceForBackendAsync({ backend, discovery, staged });
	return {
		collectsCoverage: staged.effectiveConfig.collectCoverage,
		placeBuildMs: placeBuild.elapsedMs,
		staged,
	};
}

function noProjectRuntime(
	rootConfig: ResolvedConfig,
): Pick<FinishedRun<ProjectLayoutTypes>, "dispatched" | "staged"> {
	const staged = {
		cacheRoot: stubCacheRoot(rootConfig.rootDir),
		coverageMs: 0,
		effectiveConfig: rootConfig,
		stagingMs: 0,
	};
	return { dispatched: [], staged: { placeBuildMs: 0, staged } };
}

function createProjectLayout(input: ProjectLayoutInput): RunLayout<ProjectLayoutTypes> {
	const { cli } = input;
	const context: ProjectLayoutContext = {
		...input,
		cliTypecheck: toTypecheckCliOptions(cli),
		rootConfig: withRojoProject(input.rootConfig, input.fileSystem),
	};

	return {
		buildResult: (run) => buildProjectResult(context, run),
		dispatchAsync: async ({ backend, selection, staged }) => {
			return dispatchProjectJobsAsync(context, {
				backend,
				plan: selection.plan,
				staged,
			});
		},
		noRuntime: () => noProjectRuntime(input.rootConfig),
		openBackend: () => {
			const { fileSystem, rootConfig, seams } = input;
			return seams.openBackend({ cli, config: rootConfig, fileSystem, workspace: false });
		},
		resolveUnitsAsync: async () => resolveProjectUnitsAsync(context),
		selectTests: ({ allProjects }) => selectProjectTests(context, allProjects),
		stageAsync: async ({ backend, selection }) => {
			return stageProjectsAsync(context, { backend, selection });
		},
		typecheckAsync: async ({ plan }) => typecheckProjectsAsync(context, plan),
	};
}
