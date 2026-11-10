import * as os from "node:os";
import process from "node:process";

import { parseArgs } from "./cli-args.ts";
import { printError } from "./cli-errors.ts";
import { renderHelp } from "./cli-help.ts";
import { ConfigError } from "./config/errors.ts";
import { loadConfig } from "./config/loader.ts";
import { mergeCliWithConfig } from "./config/merge.ts";
import type { CliOptions, ResolvedConfig } from "./config/resolved-config.ts";
import { outputRunAsync } from "./output/output.ts";
import { createStdoutRunProgress } from "./progress/reporter.ts";
import type { RunResult } from "./results/run-result-types.ts";
import { runMergedJestRobloxAsync } from "./run-entry.ts";
import { withRunLogAsync } from "./run/run-log.ts";
import { aliasVersionWarning, formatSetupOutcome, runSetup, SETUP_COMMAND } from "./setup/setup.ts";
import type { FileSystem } from "./utils/file-system.ts";
import { nodeFileSystem } from "./utils/file-system.ts";
import {
	INFRASTRUCTURE_EXIT_CODE,
	isInfrastructureFailure,
} from "./utils/infrastructure-failure.ts";
import { VERSION } from "./version.ts";

/** Everything the invocation reaches the outside world through. */
export interface CliDependencies {
	/** File system for config, output and artifacts. */
	fileSystem?: FileSystem;
	/** Home folder that setup writes the type module under. */
	homeDirectory?: string;
	/** Loads the package config. */
	loadConfig?: typeof loadConfig;
	/** Writes the run result to the configured sinks. */
	outputRun?: typeof outputRunAsync;
	/** Runs the tests. */
	runJestRoblox?: typeof runMergedJestRobloxAsync;
}

type ResolvedCliDependencies = Required<CliDependencies>;

interface ReportedRun {
	exitCode: number;
	output: RunResult["output"];
}

const NODE_DEPENDENCIES: ResolvedCliDependencies = {
	fileSystem: nodeFileSystem,
	homeDirectory: os.homedir(),
	loadConfig,
	outputRun: outputRunAsync,
	runJestRoblox: runMergedJestRobloxAsync,
};

/**
 * Run one CLI invocation and catch any error it throws.
 * @param args - Arguments after the executable and script path.
 * @param dependencies - Overrides for the Node dependencies.
 * @returns The process exit code.
 */
export async function runAsync(
	args: Array<string>,
	dependencies?: CliDependencies,
): Promise<number> {
	try {
		return await runInnerAsync(args, { ...NODE_DEPENDENCIES, ...dependencies });
	} catch (err) {
		printError(err);
		return isInfrastructureFailure(err) ? INFRASTRUCTURE_EXIT_CODE : 2;
	}
}

/**
 * Run the CLI on `process.argv` and set `process.exitCode`.
 * @param dependencies - Overrides for the Node dependencies.
 */
export async function main(dependencies?: CliDependencies): Promise<void> {
	const exitCode = await runAsync(process.argv.slice(2), dependencies);
	process.exitCode = exitCode;
}

function runSetupCommand({ fileSystem, homeDirectory }: ResolvedCliDependencies): number {
	const outcome = runSetup({ cwd: process.cwd(), fileSystem, homeDirectory, version: VERSION });
	if (outcome.kind === "unreadable") {
		throw new ConfigError(
			`Failed to read ${outcome.configFile}: ${outcome.problem}`,
			`Fix the file and run setup again, or add this entry to its "aliases" by hand: ${outcome.entry}`,
		);
	}

	process.stdout.write(formatSetupOutcome(outcome));
	return 0;
}

async function dispatchResultAsync({
	dependencies: { fileSystem, outputRun },
	result,
}: {
	dependencies: ResolvedCliDependencies;
	result: RunResult;
}): Promise<number> {
	if (result.validationMessage !== undefined) {
		process.stderr.write(result.validationMessage);
	}

	if (result.validationExitCode !== undefined) {
		return result.validationExitCode;
	}

	if (result.output === undefined) {
		return 0;
	}

	return outputRun({ dependencies: { fileSystem }, result });
}

async function runReportedAsync({
	cli,
	config,
	dependencies,
}: {
	cli: CliOptions;
	config: ResolvedConfig;
	dependencies: ResolvedCliDependencies;
}): Promise<ReportedRun> {
	const progress = createStdoutRunProgress();
	try {
		const result = await dependencies.runJestRoblox({
			cli,
			config,
			fileSystem: dependencies.fileSystem,
			progress,
		});
		const exitCode = await dispatchResultAsync({ dependencies, result });
		return { exitCode, output: result.output };
	} finally {
		progress.finish();
	}
}

async function runLoggedAsync({
	cli,
	config,
	dependencies,
}: {
	cli: CliOptions;
	config: ResolvedConfig;
	dependencies: ResolvedCliDependencies;
}): Promise<number> {
	const { fileSystem } = dependencies;
	const reported = await withRunLogAsync(
		{
			config,
			fileSystem,
			runTarget: ({ output }) => output,
			streams: { stderr: process.stderr, stdout: process.stdout },
		},
		async () => runReportedAsync({ cli, config, dependencies }),
	);
	return reported.exitCode;
}

function printAliasVersionWarning(fileSystem: FileSystem): void {
	const warning = aliasVersionWarning({ cwd: process.cwd(), fileSystem, version: VERSION });
	if (warning !== undefined) {
		process.stderr.write(warning);
	}
}

async function runInnerAsync(
	args: Array<string>,
	dependencies: ResolvedCliDependencies,
): Promise<number> {
	const cli = parseArgs(args);

	if (cli.help === true) {
		console.log(renderHelp());
		return 0;
	}

	if (cli.version === true) {
		console.log(VERSION);
		return 0;
	}

	if (cli.files?.[0] === SETUP_COMMAND) {
		return runSetupCommand(dependencies);
	}

	const { fileSystem } = dependencies;
	printAliasVersionWarning(fileSystem);

	const loadedConfig = await dependencies.loadConfig({
		configPath: cli.config,
		cwd: cli.workspaceRoot,
		fileSystem,
	});
	const config = mergeCliWithConfig(cli, loadedConfig);

	return runLoggedAsync({ cli, config, dependencies });
}
