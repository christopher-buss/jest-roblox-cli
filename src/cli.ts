import * as os from "node:os";
import process from "node:process";

import packageJson from "../package.json" with { type: "json" };
import { parseArgs } from "./cli-args.ts";
import { printError } from "./cli-errors.ts";
import { ConfigError } from "./config/errors.ts";
import { resolveLayoutProject } from "./config/layout-project.ts";
import { loadConfig, type PackageConfigLoader } from "./config/loader.ts";
import { mergeCliWithConfig } from "./config/merge.ts";
import type { CliOptions, ResolvedConfig } from "./config/schema.ts";
import { outputMultiResultAsync } from "./output.ts";
import { createStdoutRunProgress } from "./progress/reporter.ts";
import { withRunLogAsync } from "./run-log/run-log.ts";
import { runJestRobloxAsync } from "./run.ts";
import type { MultiRunResult, WorkspaceRunResult } from "./run/run-types.ts";
import { formatSetupOutcome, runSetup, SETUP_COMMAND } from "./setup/setup.ts";
import type { FileSystem } from "./utils/file-system.ts";
import { nodeFileSystem } from "./utils/file-system.ts";
import {
	INFRASTRUCTURE_EXIT_CODE,
	isInfrastructureFailure,
} from "./utils/infrastructure-failure.ts";

const VERSION = packageJson.version;

const HELP_TEXT = `
Usage: jest-roblox [options] [files...]
       jest-roblox related [options] <file> [files...]
       jest-roblox setup

Commands:
  related <file> [files...]         Run only the tests that reach the given
                                    source files through string requires.
                                    Instance-path, TS.import, and dynamic
                                    requires are not followed, so a test
                                    that reaches a file only through them
                                    does not run. Write a test filter named
                                    related as ./related
  setup                             Install the Luau Config type and add the
                                    "jest-roblox" alias to .config.luau or
                                    .luaurc. Write a test filter named setup
                                    as ./setup

Options:
  --backend <type>                  Backend: "auto", "open-cloud", "studio", or
                                    "studio-cli" (default: auto)
  --port <number>                   WebSocket port for studio backend (default: 3001)
  --studioPath <path>               Roblox Studio executable for the studio-cli
                                    backend (auto-detected if not set)
  --headed                          Show the Studio window during the run
                                    (studio-cli backend only; default: hidden)
  --no-hiddenDesktop                Let Studio open on the user's desktop
                                    (studio-cli backend; default: hidden on
                                    Windows and macOS)
  --config <path>                   Path to config file
  --testPathPattern <regex>         Filter test files by path pattern
  -t, --testNamePattern <regex>     Filter tests by name pattern
  --outputFile <path>               Write results to file
  --gameOutput <path>               Write game output (print/warn/error) to file
  --sourceMap                       Map Luau stack traces to TypeScript source
  --rojoProject <path>              Path to rojo project file (auto-detected if not set)
  --passWithNoTests                 Exit with 0 when no test files are found
  --verbose                         Show individual test results
  --silent                          Suppress output
  --no-color                        Disable colored output
  -u, --updateSnapshot              Update snapshot files
  --coverage                        Enable coverage collection
  --no-coverage                     Disable coverage for this run (overrides config)
  --collectCoverageFrom <glob>      Globs for files to include in coverage (repeatable)
  --coverageDirectory <path>        Directory for coverage output (default: coverage)
  --coverageReporters <name>        Coverage reporter, default text and lcov (repeatable)
  --formatters <name>               Output formatter: default, agent, json, or
                                    github-actions (repeatable)
  --bail                            Workspace mode: stop after the first failing package
  --workspace                       Run tests across all workspace packages
  --packages <names>                Comma-separated package names (narrows a workspace run)
  --workspace-root <path>           Directory to load the workspace config from
                                    (use when running outside any package)
  --affected-since <ref>            Run only packages affected since git ref via turbo/nx
  --no-coverage-cache               Force a clean coverage re-instrumentation (skip incremental cache)
  --no-upload-cache                 Always upload the place, even when its bytes are unchanged
  --parallel [n]                    Open-Cloud-only: number of concurrent sessions
                                    (or "auto" = min(jobs, 3); default: 1 session).
                                    Each session costs one task create against
                                    Roblox's create limit
  --experimental-vm-parallel [n]    Studio-only, experimental: run the configs across
                                    n Luau VMs in one Studio session (default: one
                                    VM per config; max 4, the hosts the plugin
                                    ships). Game output becomes batch-scoped.
                                    In workspace mode, splits each package's
                                    projects; packages still run in turn
  --project <name>                  Filter which named projects to run (repeatable)
  --setupFiles <path>               Setup script, a package specifier or relative path
                                    (repeatable)
  --setupFilesAfterEnv <path>       Post-env setup script, a package specifier or
                                    relative path (repeatable)
  --no-show-luau                    Hide Luau code in failure output
  --typecheck                       Enable type testing (*.spec-d.*, *.test-d.*)
  --typecheckOnly                   Run only type tests, skip runtime tests
  --typecheckTsconfig <path>        tsconfig for type testing
  --apiKey <key>                    Roblox Open Cloud API key
  --universeId <id>                 Target universe ID
  --placeId <id>                    Target place ID
  --help                            Show this help message
  --version                         Show version number

Open Cloud credentials (open-cloud backend only):
  Sources, in precedence order:
    1. CLI flags (--apiKey, --universeId, --placeId)
    2. JEST_ROBLOX_* env vars (JEST_ROBLOX_OPEN_CLOUD_API_KEY,
       JEST_ROBLOX_UNIVERSE_ID, JEST_ROBLOX_PLACE_ID)
    3. ROBLOX_* env vars (ROBLOX_OPEN_CLOUD_API_KEY, ROBLOX_UNIVERSE_ID,
       ROBLOX_PLACE_ID)
    4. jest.config.ts (universeId, placeId — apiKey is CLI/env only)

  --apiKey is visible in process listings; prefer env vars in CI.

Examples:
  jest-roblox                         Run all tests (open-cloud)
  jest-roblox --backend studio        Run tests via Studio plugin
  jest-roblox src/player.spec.ts      Run specific test file (also narrows
                                      a --workspace run to its package)
  jest-roblox related src/util.luau   Run the tests that reach src/util.luau
  jest-roblox -t "should spawn"       Run tests matching pattern
  jest-roblox --formatters json       Output JSON to file
  jest-roblox --coverage              Run tests with coverage instrumentation
  jest-roblox --no-coverage           Skip coverage instrumentation for this run
`;

/** Everything the invocation reaches the outside world through. */
export interface CliDependencies {
	/** File system for config, output and artifacts. */
	fileSystem?: FileSystem;
	/** Home folder that setup writes the type module under. */
	homeDirectory?: string;
	/** Loads the package config. */
	loadConfig?: PackageConfigLoader;
	/** Writes the run result to the configured sinks. */
	outputMultiResult?: typeof outputMultiResultAsync;
	/** Runs the tests. */
	runJestRoblox?: typeof runJestRobloxAsync;
}

type ResolvedCliDependencies = Required<CliDependencies>;

const NODE_DEPENDENCIES: ResolvedCliDependencies = {
	fileSystem: nodeFileSystem,
	homeDirectory: os.homedir(),
	loadConfig,
	outputMultiResult: outputMultiResultAsync,
	runJestRoblox: runJestRobloxAsync,
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

async function dispatchResultAsync({
	config,
	dependencies: { fileSystem, outputMultiResult },
	result,
}: {
	config: ResolvedConfig;
	dependencies: ResolvedCliDependencies;
	result: MultiRunResult | WorkspaceRunResult;
}): Promise<number> {
	if (result.validationMessage !== undefined) {
		process.stderr.write(result.validationMessage);
	}

	if (result.validationExitCode !== undefined) {
		return result.validationExitCode;
	}

	if (result.projectResults.length === 0 && result.typecheckResult === undefined) {
		return 0;
	}

	return outputMultiResult({ dependencies: { fileSystem }, result, rootConfig: config });
}

/**
 * The CLI owns the terminal for the whole invocation, so it owns the stage
 * block: the run is only part of it, and a run that throws leaves the block
 * open. Settled in a `finally`, so that block still names the step it died
 * inside rather than freezing on a spinner.
 *
 * @param options - Parsed CLI options, resolved config and dependencies.
 * @returns The exit code of the dispatched result.
 */
async function runReportedAsync({
	cli,
	config,
	dependencies,
}: {
	cli: CliOptions;
	config: ResolvedConfig;
	dependencies: ResolvedCliDependencies;
}): Promise<number> {
	const progress = createStdoutRunProgress();
	try {
		const result = await dependencies.runJestRoblox({
			cli,
			config,
			fileSystem: dependencies.fileSystem,
			progress,
		});
		return await dispatchResultAsync({ config, dependencies, result });
	} finally {
		progress.finish();
	}
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

async function runInnerAsync(
	args: Array<string>,
	dependencies: ResolvedCliDependencies,
): Promise<number> {
	const cli = parseArgs(args);

	if (cli.help === true) {
		console.log(HELP_TEXT);
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

	const loadedConfig = await dependencies.loadConfig({
		configPath: cli.config,
		cwd: cli.workspaceRoot,
		fileSystem,
	});
	const merged = mergeCliWithConfig(cli, loadedConfig);
	const config =
		cli.workspace === true ? merged : resolveLayoutProject({ config: merged, fileSystem });

	// The log wraps the whole invocation because it holds what the terminal
	// held, the stage block included.
	return withRunLogAsync(
		{ config, fileSystem, streams: { stderr: process.stderr, stdout: process.stdout } },
		async () => runReportedAsync({ cli, config, dependencies }),
	);
}
