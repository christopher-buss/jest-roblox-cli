import process from "node:process";

import packageJson from "../../package.json" with { type: "json" };
import type { StudioInstalledCheck } from "../backends/auto.ts";
import { isStudioDiscoverable } from "../backends/auto.ts";
import type { Backend } from "../backends/interface.ts";
import { createOpenCloudBackend } from "../backends/open-cloud.ts";
import { createStudioCliBackend } from "../backends/studio-cli.ts";
import { createStudioBackend } from "../backends/studio.ts";
import { loadRawConfig } from "../config/loader.ts";
import type { CliOptions, WorkspaceConfig, WorkspaceRunOptions } from "../config/schema.ts";
import { aggregateWorkspaceCoverage } from "../coverage-pipeline/workspace-aggregate.ts";
import { isDefaultHumanFormatter } from "../formatters/utils.ts";
import { NOOP_RUN_PROGRESS, type RunProgress } from "../progress/reporter.ts";
import type { StreamingAggregatorOnEntry } from "../reporter/streaming-aggregator.ts";
import { formatStreamingProgressLine } from "../reporter/streaming-progress.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import { runTypecheckAsync } from "../typecheck/runner.ts";
import type { RunTypecheck } from "../typecheck/runner.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { nodeChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { runWorkspaceAsync, type WorkspaceRunnerOutput } from "../workspace-runner.ts";
import type { PackageInfo } from "../workspace/package-resolver.ts";
import { emitRunHeader } from "./run-header.ts";
import type { WorkspaceRunResult } from "./run-types.ts";
import {
	resolveWorkspaceBackend,
	resolveWorkspaceOptionsAsync,
	type WorkspaceBackendResolution,
} from "./workspace-backend.ts";
import { type ResolvedPackages, resolvePackages } from "./workspace-packages.ts";
import { buildWorkspaceResult, EMPTY_RESULT } from "./workspace-result.ts";
import { validateBasicWorkspaceFlags } from "./workspace-validation.ts";

const VERSION = packageJson.version;

/** Everything workspace mode reaches the outside world through. */
interface WorkspaceModeDependencies {
	/** Folds per-package coverage into per-package reports. */
	aggregateCoverage?: typeof aggregateWorkspaceCoverage;
	/** Runs child processes. */
	childProcess?: ChildProcessRunner;
	/** File system of the run. */
	fileSystem?: FileSystem;
	/** Checks for a local Studio when the backend is auto. */
	isStudioInstalled?: StudioInstalledCheck;
	/** Loads one package's raw config. */
	loadPackageConfig?: typeof loadRawConfig;
	/** Creates the Open Cloud backend. */
	openCloudBackend?: typeof createOpenCloudBackend;
	/** Runs one tsgo pass. */
	runTypecheck?: RunTypecheck;
	/** Runs the selected packages. */
	runWorkspace?: typeof runWorkspaceAsync;
	/** Creates the attached Studio backend. */
	studioBackend?: typeof createStudioBackend;
	/** Creates the self-launched Studio backend. */
	studioCliBackend?: typeof createStudioCliBackend;
}

type ResolvedDependencies = Required<WorkspaceModeDependencies>;

const NODE_DEPENDENCIES: ResolvedDependencies = {
	aggregateCoverage: aggregateWorkspaceCoverage,
	childProcess: nodeChildProcessRunner,
	fileSystem: nodeFileSystem,
	isStudioInstalled: isStudioDiscoverable,
	loadPackageConfig: loadRawConfig,
	openCloudBackend: createOpenCloudBackend,
	runTypecheck: runTypecheckAsync,
	runWorkspace: runWorkspaceAsync,
	studioBackend: createStudioBackend,
	studioCliBackend: createStudioCliBackend,
};

/** Inputs of {@link runWorkspaceModeAsync}. */
export interface RunWorkspaceModeOptions {
	/** Parsed command-line options. */
	cli: CliOptions;
	/** Overrides of the Node dependencies. */
	dependencies?: undefined | WorkspaceModeDependencies;
	/** Profiler of the run, if any. */
	timing?: TimingCollector | undefined;
	/** The `workspace` config block, if any. */
	workspace?: undefined | WorkspaceConfig;
}

interface ExecuteWorkspaceRunOptions {
	cli: CliOptions;
	dependencies: ResolvedDependencies;
	packageInfos: Array<PackageInfo>;
	runOptions: WorkspaceRunOptions;
	timing?: TimingCollector | undefined;
	workspaceRoot: string;
}

type DriveWorkspaceRunOptions = ExecuteWorkspaceRunOptions & {
	backend: Backend | undefined;
	progress: RunProgress;
	workStealingCredentials: WorkspaceBackendResolution["workStealingCredentials"];
};

/**
 * Validate the workspace flags, select the packages and run them.
 *
 * @param options - CLI options, dependencies, profiler and workspace config.
 * @param options.cli - Parsed command-line options.
 * @param options.dependencies - Overrides of the Node dependencies.
 * @param options.timing - Profiler of the run, if any.
 * @param options.workspace - The `workspace` config block, if any.
 * @returns The workspace-run result; validation failures carry exit code `2`.
 */
export async function runWorkspaceModeAsync({
	cli,
	dependencies,
	timing,
	workspace,
}: RunWorkspaceModeOptions): Promise<WorkspaceRunResult> {
	const settled = { ...NODE_DEPENDENCIES, ...dependencies };

	const basicValidation = validateBasicWorkspaceFlags(cli);
	if (!basicValidation.ok) {
		return bail(basicValidation.exitCode, basicValidation.message);
	}

	const resolved = resolvePackages({ cli, dependencies: settled, workspace });
	if (resolved.error !== undefined) {
		return bail(resolved.error.exitCode, resolved.error.message);
	}

	if (resolved.noAffected === true) {
		process.stdout.write("No affected packages — nothing to test.\n");
		return EMPTY_RESULT;
	}

	return runSelectedPackagesAsync({ cli, dependencies: settled, resolved, timing });
}

/**
 * Every validation failure reports through the same empty result, so the
 * per-branch difference is only the exit code and (optionally) the message.
 * Add `validationMessage` only when defined so the "no message" case keeps the
 * key absent, as before.
 *
 * @param validationExitCode - Exit code of the failure.
 * @param validationMessage - Message for stderr, if any.
 * @returns An empty workspace result that carries the failure.
 */
function bail(validationExitCode: 2, validationMessage?: string): WorkspaceRunResult {
	const result = {
		...EMPTY_RESULT,
		validationExitCode,
	} satisfies WorkspaceRunResult;
	return validationMessage === undefined ? result : { ...result, validationMessage };
}

/**
 * `collectCoverage` is intentionally omitted: workspace coverage is per-package
 * (driven by each package's manifest), so there is no workspace-level flag to
 * surface the "Coverage enabled" subtitle.
 *
 * @param options - CLI options, progress, run options and workspace root.
 * @param options.cli - Parsed command-line options; supplies `verbose`.
 * @param options.progress - Progress the header reveals.
 * @param options.runOptions - Consensus-resolved run options.
 * @param options.workspaceRoot - Directory the header names.
 */
function emitWorkspaceRunHeader({
	cli,
	progress,
	runOptions,
	workspaceRoot,
}: {
	cli: CliOptions;
	progress: RunProgress;
	runOptions: WorkspaceRunOptions;
	workspaceRoot: string;
}): void {
	emitRunHeader({
		color: runOptions.color,
		formatters: runOptions.formatters,
		progress,
		rootDir: workspaceRoot,
		silent: runOptions.silent,
		verbose: cli.verbose,
		version: VERSION,
	});
}

/**
 * Build a streaming progress sink when the human formatter is active. Returns
 * undefined for JSON/agent/silent runs — those formatters buffer a single
 * final envelope so live per-package stdout writes would
 * either break the structured output or be silenced anyway.
 *
 * @param options - CLI options, progress and run options.
 * @param options.cli - Parsed command-line options; supplies `verbose`.
 * @param options.progress - Progress the lines interleave with.
 * @param options.runOptions - Consensus-resolved run options.
 * @returns The per-entry sink, or `undefined` when output is not for a human.
 */
function resolveStreamingProgressSink({
	cli,
	progress,
	runOptions,
}: {
	cli: CliOptions;
	progress: RunProgress;
	runOptions: WorkspaceRunOptions;
}): StreamingAggregatorOnEntry | undefined {
	if (
		!isDefaultHumanFormatter({
			formatters: runOptions.formatters,
			silent: runOptions.silent,
			verbose: cli.verbose,
		})
	) {
		return undefined;
	}

	/**
	 * Through the reporter rather than stdout: a live stage block owns the last
	 * lines on screen, so a bare write would land inside it and leave the next
	 * repaint erasing this line in place of its own rows.
	 *
	 * @param entry - Streamed result entry of one package.
	 */
	return (entry) => {
		const line = formatStreamingProgressLine(entry, { color: runOptions.color });
		progress.interleave(() => {
			process.stdout.write(`${line}\n`);
		});
	};
}

async function driveWorkspaceRunAsync({
	backend,
	cli,
	dependencies,
	packageInfos,
	progress,
	runOptions,
	timing,
	workspaceRoot,
	workStealingCredentials,
}: DriveWorkspaceRunOptions): Promise<undefined | WorkspaceRunnerOutput> {
	try {
		emitWorkspaceRunHeader({ cli, progress, runOptions, workspaceRoot });
		return await dependencies.runWorkspace({
			backend,
			childProcess: dependencies.childProcess,
			cli,
			// Read here, the layer that already reads it to discover the
			// workspace root above it.
			cwd: process.cwd(),
			fileSystem: dependencies.fileSystem,
			onStreamingResult: resolveStreamingProgressSink({ cli, progress, runOptions }),
			packageInfos,
			runOptions,
			runTypecheck: dependencies.runTypecheck,
			timing,
			version: VERSION,
			workspaceRoot,
			workStealingCredentials,
		});
	} finally {
		await backend?.closeAsync?.();
	}
}

async function executeWorkspaceRunAsync(
	input: ExecuteWorkspaceRunOptions,
): Promise<WorkspaceRunResult> {
	const { cli, dependencies, runOptions, timing, workspaceRoot } = input;
	const resolution = resolveWorkspaceBackend({ cli, dependencies, runOptions });
	if (resolution.error !== undefined) {
		return bail(resolution.error.exitCode, resolution.error.message);
	}

	const output = await driveWorkspaceRunAsync({
		...input,
		backend: resolution.backend,
		progress: timing?.progress ?? NOOP_RUN_PROGRESS,
		workStealingCredentials: resolution.workStealingCredentials,
	});

	if (output === undefined) {
		return bail(2);
	}

	return buildWorkspaceResult({
		aggregateCoverage: dependencies.aggregateCoverage,
		cli,
		output,
		runOptions,
		workspaceRoot,
	});
}

async function runSelectedPackagesAsync({
	cli,
	dependencies,
	resolved,
	timing,
}: {
	cli: CliOptions;
	dependencies: ResolvedDependencies;
	resolved: ResolvedPackages;
	timing?: TimingCollector | undefined;
}): Promise<WorkspaceRunResult> {
	// oxlint-disable-next-line typescript/no-non-null-assertion -- guaranteed when no error/noAffected
	const packageInfos = resolved.packageInfos!;
	// oxlint-disable-next-line typescript/no-non-null-assertion -- guaranteed when no error/noAffected
	const workspaceRoot = resolved.workspaceRoot!;

	const optionsResolution = await resolveWorkspaceOptionsAsync({
		cli,
		fileSystem: dependencies.fileSystem,
		isStudioInstalled: dependencies.isStudioInstalled,
		loadPackageConfig: dependencies.loadPackageConfig,
		packageInfos,
		workspaceRoot,
	});
	if (optionsResolution.error !== undefined) {
		return bail(optionsResolution.error.exitCode, optionsResolution.error.message);
	}

	// oxlint-disable-next-line typescript/no-non-null-assertion -- guaranteed when there is no error
	const runOptions = optionsResolution.runOptions!;

	return executeWorkspaceRunAsync({
		cli,
		dependencies,
		packageInfos,
		runOptions,
		timing,
		workspaceRoot,
	});
}
