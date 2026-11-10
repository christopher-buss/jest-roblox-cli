import process from "node:process";

import type { WorkspaceConfig } from "../config/config-types.ts";
import { isDefaultHumanFormatter } from "../config/formatter-selection.ts";
import type { CliOptions, WorkspaceRunOptions } from "../config/resolved-config.ts";
import { buildWorkspaceRunOptions } from "../config/workspace-run-options.ts";
import type { RunProgress } from "../progress/run-progress.ts";
import type { RunResult } from "../results/run-result-types.ts";
import type { FinishedRun, RunLayout, RunRefusal, RunUnits } from "../run/pipeline.ts";
import type { RunSeams } from "../run/seams.ts";
import { createStyles } from "../terminal/palette.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { loadPackageConfigsAsync, type WorkspacePackage } from "./package-loader.ts";
import type { PackageInfo } from "./package-resolver.ts";
import { resolvePackages } from "./packages.ts";
import type { StagedWorkspacePlace } from "./place-staging.ts";
import { buildWorkspaceResult, EMPTY_RESULT } from "./result.ts";
import {
	createWorkspaceRunStages,
	type DispatchedWorkspace,
	type WorkspaceRunStages,
	type WorkspaceSelection,
} from "./run-stages.ts";
import type { StreamingAggregatorOnEntry } from "./streaming-aggregator.ts";
import { formatStreamingProgressLine } from "./streaming-progress.ts";
import type { WorkspaceTypecheckPass } from "./typecheck-pass.ts";
import { validateBasicWorkspaceFlags } from "./validation.ts";

/** Inputs of {@link createWorkspaceLayout}. */
export interface WorkspaceLayoutInput {
	/** Parsed command-line options. */
	cli: CliOptions;
	/** Builds the stages of a run over loaded packages. */
	createRunStages?: typeof createWorkspaceRunStages;
	/** Where the run reads and writes. */
	fileSystem: FileSystem;
	/** Stage reporter of the run. */
	progress: RunProgress;
	/** Seams the run reaches outside itself through. */
	seams: RunSeams;
	/** Profiler of the run. */
	timing: TimingCollector;
	/** The `workspace` config block, if any. */
	workspace?: undefined | WorkspaceConfig;
}

/** The types the workspace layout works in. */
export interface WorkspaceLayoutTypes {
	/** Results of the entries that ran. */
	dispatched: DispatchedWorkspace;
	/** Selected tests of every package. */
	selection: WorkspaceLayoutSelection;
	/** The staged synthesized place. */
	staged: StagedWorkspacePlace;
	/** Per-package Type Test pass. */
	typecheck: WorkspaceTypecheckPass;
	/** Loaded packages and the run options they agree on. */
	units: WorkspaceUnits;
}

interface WorkspaceLayoutSelection extends WorkspaceSelection {
	stages: WorkspaceRunStages;
}

interface WorkspaceUnits extends RunUnits {
	runOptions: WorkspaceRunOptions;
	stages: WorkspaceRunStages;
	workspaceRoot: string;
}

/**
 * The layout of a workspace run, with one unit per package.
 * @param input - CLI options, dependencies, profiler and workspace config.
 * @returns Answers that read each package's own config.
 */
export function createWorkspaceLayout(
	input: WorkspaceLayoutInput,
): RunLayout<WorkspaceLayoutTypes> {
	const { cli, fileSystem, seams } = input;

	return {
		buildResult: (run) => buildResult(input, run),
		dispatchAsync: async (stage) => stage.selection.stages.dispatchAsync(stage),
		noRuntime: (selection) => selection.stages.noRuntime(selection),
		openBackend: ({ runOptions }) => {
			return seams.openBackend({ cli, config: runOptions, fileSystem, workspace: true });
		},
		resolveUnitsAsync: async () => resolveUnitsAsync(input),
		selectTests: async ({ stages }) => {
			const selection = await stages.selectTestsAsync();
			return "refused" in selection ? selection : { ...selection, stages };
		},
		stageAsync: async ({ selection }) => selection.stages.stageAsync(selection),
		typecheckAsync: async (selection) => selection.stages.typecheckAsync(selection),
	};
}

function bail(validationExitCode: 2, validationMessage: string): RunRefusal {
	return { refused: { ...EMPTY_RESULT, validationExitCode, validationMessage } };
}

function resolveStreamingProgressSink({
	progress,
	runOptions,
}: {
	progress: RunProgress;
	runOptions: WorkspaceRunOptions;
}): StreamingAggregatorOnEntry | undefined {
	if (
		!isDefaultHumanFormatter({
			formatters: runOptions.formatters,
			silent: runOptions.silent,
			verbose: runOptions.verbose,
		})
	) {
		return undefined;
	}

	/**
	 * Write through `progress.interleave`: a bare write breaks the stage
	 * block.
	 *
	 * @param entry - Streamed result entry of one package.
	 */
	return (entry) => {
		const line = formatStreamingProgressLine(entry, createStyles(runOptions.color));
		progress.interleave(() => {
			process.stdout.write(`${line}\n`);
		});
	};
}

function createStages(
	{
		cli,
		createRunStages = createWorkspaceRunStages,
		fileSystem,
		progress,
		seams,
		timing,
	}: WorkspaceLayoutInput,
	{
		packages,
		runOptions,
		workspaceRoot,
	}: {
		packages: Array<WorkspacePackage>;
		runOptions: WorkspaceRunOptions;
		workspaceRoot: string;
	},
): WorkspaceRunStages {
	return createRunStages({
		childProcess: seams.childProcess,
		cli,
		createSetupResolver: seams.createSetupResolver,
		cwd: process.cwd(),
		fileSystem,
		onStreamingResult: resolveStreamingProgressSink({ progress, runOptions }),
		packages,
		prepareCoverage: seams.prepareWorkspaceCoverage,
		progress,
		runOptions,
		runProjects: seams.runProjects,
		runTypecheck: seams.runTypecheck,
		timing,
		tsconfigReader: seams.tsconfigReader,
		workspaceRoot,
	});
}

async function loadUnitsAsync(
	input: WorkspaceLayoutInput,
	{ packageInfos, workspaceRoot }: { packageInfos: Array<PackageInfo>; workspaceRoot: string },
): Promise<WorkspaceUnits> {
	const { cli, fileSystem, seams, timing } = input;
	const packages = await loadPackageConfigsAsync({
		childProcess: seams.childProcess,
		fileSystem,
		loadPackageConfig: seams.loadPackageConfig,
		packageInfos,
		timing,
	});
	const runOptions = buildWorkspaceRunOptions({
		cli,
		perPackageConfigs: packages.map(({ config, info }) => {
			return { name: info.name, config: config.declared };
		}),
		workspaceRoot,
	});

	return {
		header: {
			color: runOptions.color,
			formatters: runOptions.formatters,
			rootDir: workspaceRoot,
			silent: runOptions.silent,
			verbose: runOptions.verbose,
		},
		runOptions,
		stages: createStages(input, { packages, runOptions, workspaceRoot }),
		workspaceRoot,
	};
}

async function resolveUnitsAsync(
	input: WorkspaceLayoutInput,
): Promise<RunRefusal | WorkspaceUnits> {
	const { cli, fileSystem, seams, workspace } = input;
	const basicValidation = validateBasicWorkspaceFlags(cli);
	if (!basicValidation.ok) {
		return bail(basicValidation.exitCode, basicValidation.message);
	}

	const resolved = resolvePackages({
		cli,
		dependencies: { childProcess: seams.childProcess, fileSystem },
		workspace,
	});
	if (resolved.kind === "error") {
		return bail(2, resolved.message);
	}

	if (resolved.kind === "none-affected") {
		process.stdout.write("No affected packages — nothing to test.\n");
		return { refused: EMPTY_RESULT };
	}

	return loadUnitsAsync(input, resolved);
}

function buildResult(
	{ seams }: WorkspaceLayoutInput,
	run: FinishedRun<WorkspaceLayoutTypes>,
): RunResult {
	const { runOptions, stages, workspaceRoot } = run.units;
	const output = stages.collectOutput(run);
	const result = buildWorkspaceResult({
		changedFiles: run.selection.selection.changedFiles,
		mapCoverage: seams.mapCoverage,
		output,
		runOptions,
		workspaceRoot,
	});
	return { ...result, affected: run.selection.selection.affected };
}
