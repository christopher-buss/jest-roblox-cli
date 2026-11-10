import { mergeCliWithConfig } from "./config/merge.ts";
import type { CliOptions, ResolvedConfig } from "./config/resolved-config.ts";
import { NOOP_RUN_PROGRESS, type RunProgress } from "./progress/run-progress.ts";
import { createStageAnnouncer } from "./progress/stage-announcer.ts";
import type { RunResult } from "./results/run-result-types.ts";
import { runPipelineAsync } from "./run/pipeline.ts";
import { runProjectLayoutAsync } from "./run/project-layout.ts";
import {
	readTimingSetting,
	type RunEntryOptions,
	settleRunEntry,
} from "./run/run-entry-options.ts";
import { createTimingCollector } from "./timing/orchestration-collector.ts";
import { createWorkspaceLayout } from "./workspace/layout.ts";
import { EMPTY_RESULT } from "./workspace/result.ts";
import { refuseWorkspaceOnlyFlags } from "./workspace/validation.ts";

/** Input to `runJestRobloxAsync`. */
export interface RunJestRobloxOptions extends RunEntryOptions {
	/** Parsed CLI options. */
	cli: CliOptions;
	/** Loaded config, before CLI options are merged in. */
	config: ResolvedConfig;
	/** Stage reporter for the run. */
	progress?: RunProgress | undefined;
	/** See {@link readTimingSetting}; defaults to it. */
	timingReport?: boolean | undefined;
}

/**
 * Run single, multi or workspace mode on a config the CLI options are already
 * merged into, and emit the Build Manifest when the coverage place was rebuilt.
 * @param options - CLI, merged config, progress and run dependencies.
 * @returns The multi or workspace run result.
 */
export async function runMergedJestRobloxAsync(options: RunJestRobloxOptions): Promise<RunResult> {
	const refusal = refuseWorkspaceOnlyFlags(options.cli);
	if (refusal !== undefined) {
		return { ...EMPTY_RESULT, validationExitCode: 2, validationMessage: refusal };
	}

	return runModeAsync(options);
}

/**
 * Run single, multi or workspace mode with the CLI options applied over
 * `config`.
 * @param options - CLI, config, progress and run dependencies.
 * @returns The multi or workspace run result.
 */
export async function runJestRobloxAsync({
	cli,
	config,
	...options
}: RunJestRobloxOptions): Promise<RunResult> {
	return runMergedJestRobloxAsync({ cli, config: mergeCliWithConfig(cli, config), ...options });
}

async function runModeAsync({
	cli,
	config,
	progress = NOOP_RUN_PROGRESS,
	timingReport = readTimingSetting(),
	...options
}: RunJestRobloxOptions): Promise<RunResult> {
	const settled = settleRunEntry(options);
	const { fileSystem, seams } = settled;
	const timing = createTimingCollector({
		enabled: timingReport,
		listener: createStageAnnouncer(progress),
	});
	try {
		if (cli.workspace === true) {
			const layout = createWorkspaceLayout({
				cli,
				fileSystem,
				progress,
				seams,
				timing,
				workspace: config.workspace,
			});
			return await runPipelineAsync(layout, { progress, timing });
		}

		return await runProjectLayoutAsync({
			cli,
			progress,
			rootConfig: config,
			timing,
			...settled,
		});
	} finally {
		timing.flushTimingReport();
	}
}
