import assert from "node:assert";

import type { Backend } from "../backends/dispatch-request.ts";
import type { RunSettings } from "../backends/interface.ts";
import { dispatchJobsAsync } from "../executor/dispatch-jobs.ts";
import type { JobResult } from "../executor/executor.ts";
import type { UnitTypecheckResult } from "../results/run-result-types.ts";
import type { RunRefusal, StagedInputs, TestSelection } from "../run/pipeline.ts";
import { attachCoverageManifests, type WorkspaceProjectResult } from "./coverage-attach.ts";
import { prepareWorkspaceDispatch } from "./dispatch.ts";
import { type OpenedWorkspaceRun, openWorkspaceRunAsync } from "./open-run.ts";
import {
	type StagedWorkspacePlace,
	stageWorkspacePlaceAsync,
	synthesizedPlaceFile,
} from "./place-staging.ts";
import { EMPTY_RESULT } from "./result.ts";
import type { RunWorkspaceOptions } from "./run-stage-types.ts";
import type { PendingEntry, TypeTestProject, WorkspaceTestSelection } from "./test-selection.ts";
import {
	runWorkspaceTypecheckPassAsync,
	type WorkspaceRunnerOutput,
	type WorkspaceTypecheckPass,
} from "./typecheck-pass.ts";

/** The tests a workspace run selected, with the opened workspace. */
export interface WorkspaceSelection extends OpenedWorkspaceRun, TestSelection {}

/** What the backend ran. */
export interface DispatchedWorkspace {
	/** Results of the pending entries that ran, each naming its entry. */
	results: Array<JobResult>;
}

/** The workspace answers to the stages after the units are resolved. */
export interface WorkspaceRunStages {
	/** Collects the runner output. */
	collectOutput(run: FinishedWorkspaceRun): WorkspaceRunnerOutput;
	/** Dispatches the runtime jobs. */
	dispatchAsync(input: {
		backend: Backend;
		selection: WorkspaceSelection;
		staged: StagedWorkspacePlace;
	}): Promise<DispatchedWorkspace>;
	/** What a run with no runtime job dispatched and staged. */
	noRuntime(selection: WorkspaceSelection): {
		dispatched: DispatchedWorkspace;
		staged: StagedWorkspacePlace;
	};
	/** Loads, validates and selects the tests of every package. */
	selectTestsAsync(): Promise<RunRefusal | WorkspaceSelection>;
	/** Stages the stubs, coverage and the synthesized place. */
	stageAsync(selection: WorkspaceSelection): Promise<StagedInputs & StagedWorkspacePlace>;
	/** Runs the per-package Type Test pass. */
	typecheckAsync(selection: WorkspaceSelection): Promise<WorkspaceTypecheckPass>;
}

/** What a workspace run did, for its output to be collected from. */
interface FinishedWorkspaceRun {
	/** What the backend ran. */
	dispatched: DispatchedWorkspace;
	/** Tests the run selected. */
	selection: WorkspaceSelection;
	/** The staged place. */
	staged: StagedWorkspacePlace;
	/** The per-package Type Test pass. */
	typecheck: WorkspaceTypecheckPass;
}

/**
 * The stages of a workspace run over packages already loaded.
 * @param context - Run inputs and seams.
 * @returns One answer per pipeline stage, each reading the same context.
 */
export function createWorkspaceRunStages(context: RunWorkspaceOptions): WorkspaceRunStages {
	return {
		collectOutput,
		dispatchAsync: async ({ backend, selection, staged }) => {
			return dispatchAsync(context, { backend, selection: selection.selection, staged });
		},
		noRuntime: ({ cacheDirectory }) => {
			return {
				dispatched: { results: [] },
				staged: {
					coverageByPackage: new Map(),
					coverageMs: 0,
					placeFile: synthesizedPlaceFile(cacheDirectory),
					stagingMs: 0,
				},
			};
		},
		selectTestsAsync: async () => selectTestsAsync(context),
		stageAsync: async ({ cacheDirectory, loaded, selection }) => {
			return stageWorkspacePlaceAsync({ ...context, cacheDirectory, loaded, selection });
		},
		typecheckAsync: async ({ selection }) => {
			return runWorkspaceTypecheckPassAsync({
				...selection,
				runTypecheck: context.runTypecheck,
			});
		},
	};
}

async function selectTestsAsync(
	context: RunWorkspaceOptions,
): Promise<RunRefusal | WorkspaceSelection> {
	const opened = await openWorkspaceRunAsync(context);
	if (opened === undefined) {
		return { refused: { ...EMPTY_RESULT, validationExitCode: 2 } };
	}

	const { emptiness, pending, typeTestEntries } = opened.selection;
	return { ...opened, emptiness, runtimeJobCount: pending.length, typeTestEntries };
}

function toRunSettings(
	{ runOptions, workspaceRoot }: RunWorkspaceOptions,
	staged: StagedWorkspacePlace,
): RunSettings {
	return {
		bootProbeTimeout: runOptions.bootProbeTimeout,
		placeFile: staged.placeFile,
		rootDir: workspaceRoot,
		timeout: runOptions.timeout,
		uploadCache: runOptions.uploadCache,
	};
}

async function dispatchAsync(
	context: RunWorkspaceOptions,
	{
		backend,
		selection,
		staged,
	}: { backend: Backend; selection: WorkspaceTestSelection; staged: StagedWorkspacePlace },
): Promise<DispatchedWorkspace> {
	const { pending, tsconfigCache } = selection;
	const jobs = pending.map((entry) => entry.job);
	const runSettings = toRunSettings(context, staged);
	const dispatch = context.timing.profile("prepareDispatch", () => {
		return prepareWorkspaceDispatch({
			bail: context.runOptions.bail,
			onStreamingResult: context.onStreamingResult,
			parallel: context.runOptions.parallel,
			vmParallel: context.runOptions.experimentalVmParallel,
		});
	});

	return dispatchJobsAsync({
		backend,
		dispatch,
		fileSystem: context.fileSystem,
		jobs,
		progress: context.progress,
		runProjects: context.runProjects,
		runSettings,
		timing: context.timing,
		tsconfigCache,
		tsconfigReader: context.tsconfigReader,
	});
}

/**
 * The packages a bail never ran.
 *
 * @param pending - Pending entries in dispatch order.
 * @param results - Results of the entries that ran.
 * @returns The packages with no project run.
 */
function findBailedPackages(
	pending: Array<PendingEntry>,
	results: Array<WorkspaceProjectResult>,
): Array<string> {
	const ranPackages = new Set(results.map((result) => result.pkg));
	return [
		...new Set(pending.map((entry) => entry.job.pkg).filter((name) => !ranPackages.has(name))),
	];
}

function toTypecheckUnits(
	typeTestProjects: Array<TypeTestProject>,
	byPackage: WorkspaceTypecheckPass["byPackage"],
): Array<UnitTypecheckResult> {
	return typeTestProjects.map(({ pkg, project }) => {
		const result = byPackage.get(pkg);
		assert(result !== undefined, "every Type Test project's package ran a type pass");
		return { pkg, project, result };
	});
}

function collectOutput({
	dispatched,
	selection,
	staged,
	typecheck,
}: FinishedWorkspaceRun): WorkspaceRunnerOutput {
	const typecheckUnits = toTypecheckUnits(
		selection.selection.typeTestProjects,
		typecheck.byPackage,
	);
	const { pending } = selection.selection;
	const results = attachCoverageManifests({
		coverageByPackage: staged.coverageByPackage,
		pending,
		results: dispatched.results,
	});

	return {
		bailedPackages: findBailedPackages(pending, results),
		coverageMs: staged.coverageMs,
		results,
		stagingMs: staged.stagingMs,
		typecheckResult: typecheck.outcome.result,
		typecheckUnits,
	};
}
