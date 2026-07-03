import { OpenCloudError } from "@bedrock-rbx/ocale";

import process from "node:process";
import { parseArgs as nodeParseArgs } from "node:util";
import color from "tinyrainbow";

import packageJson from "../package.json" with { type: "json" };
import { ConfigError } from "./config/errors.ts";
import { loadConfig } from "./config/loader.ts";
import { mergeCliWithConfig } from "./config/merge.ts";
import type { Backend, CliOptions, CoverageReporter, ResolvedConfig } from "./config/schema.ts";
import { isValidBackend, VALID_BACKENDS } from "./config/schema.ts";
import { outputMultiResult, outputSingleResult } from "./output.ts";
import { LuauScriptError } from "./reporter/parser.ts";
import { runJestRoblox } from "./run.ts";
import type { RunResult } from "./run/types.ts";
import { formatBanner } from "./utils/banner.ts";
import { type ChainEntry, formatMissingScopes, walkErrorChain } from "./utils/error-chain.ts";
import { parseGameOutput } from "./utils/game-output.ts";

const VERSION: string = packageJson.version;

const HELP_TEXT = `
Usage: jest-roblox [options] [files...]

Options:
  --backend <type>                  Backend: "auto", "open-cloud", "studio", or
                                    "studio-cli" (default: auto)
  --port <number>                   WebSocket port for studio backend (default: 3001)
  --studioPath <path>               Roblox Studio executable for the studio-cli
                                    backend (auto-detected if not set)
  --headed                          Show the Studio window during the run
                                    (studio-cli backend only; default: hidden)
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
  --coverageReporters <r...>        Coverage reporters (default: text, lcov)
  --formatters <name...>            Output formatters (default, agent, json, github-actions)
  --workspace                       Run tests across all workspace packages
  --packages <names>                Comma-separated package names (workspace mode)
  --workspace-root <path>           Directory to load the workspace config from
                                    (use when running outside any package)
  --affected-since <ref>            Run only packages affected since git ref via turbo/nx
  --no-coverage-cache               Force a clean coverage re-instrumentation (skip incremental cache)
  --parallel [n]                    Open-Cloud-only: number of concurrent sessions
                                    (or "auto" = min(jobs, 3); default: 1 session)
  --project <name...>               Filter which named projects to run
  --setupFiles <path...>            Setup scripts (package specifiers or relative paths)
  --setupFilesAfterEnv <path...>    Post-env setup scripts (package specifiers or relative paths)
  --no-show-luau                    Hide Luau code in failure output
  --typecheck                       Enable type testing (*.test-d.ts, *.spec-d.ts)
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
  jest-roblox src/player.spec.ts      Run specific test file
  jest-roblox -t "should spawn"       Run tests matching pattern
  jest-roblox --formatters json       Output JSON to file
  jest-roblox --coverage              Run tests with coverage instrumentation
  jest-roblox --no-coverage           Skip coverage instrumentation for this run
`;

export function parseArgs(args: Array<string>): CliOptions {
	const { positionals, values } = nodeParseArgs({
		allowPositionals: true,
		args: normalizeParallelFlag(args),
		options: {
			"affected-since": { type: "string" },
			"apiKey": { type: "string" },
			"backend": { type: "string" },
			"collectCoverageFrom": { multiple: true, type: "string" },
			"color": { type: "boolean" },
			"config": { type: "string" },
			"coverage": { type: "boolean" },
			"coverage-cache": { type: "boolean" },
			"coverageDirectory": { type: "string" },
			"coverageReporters": { multiple: true, type: "string" },
			"formatters": { multiple: true, type: "string" },
			"gameOutput": { type: "string" },
			"headed": { type: "boolean" },
			"help": { default: false, type: "boolean" },
			"no-color": { type: "boolean" },
			"no-coverage": { type: "boolean" },
			"no-coverage-cache": { type: "boolean" },
			"no-show-luau": { type: "boolean" },
			"outputFile": { type: "string" },
			"packages": { type: "string" },
			"parallel": { type: "string" },
			"passWithNoTests": { type: "boolean" },
			"placeId": { type: "string" },
			"port": { type: "string" },
			"project": { multiple: true, type: "string" },
			"rojoProject": { type: "string" },
			"setupFiles": { multiple: true, type: "string" },
			"setupFilesAfterEnv": { multiple: true, type: "string" },
			"showLuau": { type: "boolean" },
			"silent": { type: "boolean" },
			"sourceMap": { type: "boolean" },
			"studioPath": { type: "string" },
			"testNamePattern": { short: "t", type: "string" },
			"testPathPattern": { type: "string" },
			"timeout": { type: "string" },
			"typecheck": { type: "boolean" },
			"typecheckOnly": { type: "boolean" },
			"typecheckTsconfig": { type: "string" },
			"universeId": { type: "string" },
			"updateSnapshot": { short: "u", type: "boolean" },
			"verbose": { type: "boolean" },
			"version": { default: false, type: "boolean" },
			"workspace": { type: "boolean" },
			"workspace-root": { type: "string" },
		},
		strict: true,
	});

	const port = values.port !== undefined ? Number.parseInt(values.port, 10) : undefined;

	const timeout = values.timeout !== undefined ? Number.parseInt(values.timeout, 10) : undefined;

	return {
		affectedSince: values["affected-since"],
		apiKey: values.apiKey,
		backend: validateBackend(values.backend),
		collectCoverage: values["no-coverage"] === true ? false : values.coverage,
		collectCoverageFrom: values.collectCoverageFrom,
		color: values["no-color"] === true ? false : values.color,
		config: values.config,
		coverageCache: values["no-coverage-cache"] === true ? false : values["coverage-cache"],
		coverageDirectory: values.coverageDirectory,
		coverageReporters: values.coverageReporters as Array<CoverageReporter> | undefined,
		files: positionals.length > 0 ? positionals : undefined,
		formatters: values.formatters,
		gameOutput: values.gameOutput,
		headed: values.headed,
		help: values.help,
		outputFile: values.outputFile,
		packages: values.packages,
		parallel: parseParallelValue(values.parallel),
		passWithNoTests: values.passWithNoTests,
		placeId: values.placeId,
		port,
		project: values.project,
		rojoProject: values.rojoProject,
		setupFiles: values.setupFiles,
		setupFilesAfterEnv: values.setupFilesAfterEnv,
		showLuau: values["no-show-luau"] === true ? false : values.showLuau,
		silent: values.silent,
		sourceMap: values.sourceMap,
		studioPath: values.studioPath,
		testNamePattern: values.testNamePattern,
		testPathPattern: values.testPathPattern,
		timeout,
		typecheck: values.typecheckOnly === true ? true : values.typecheck,
		typecheckOnly: values.typecheckOnly,
		typecheckTsconfig: values.typecheckTsconfig,
		universeId: values.universeId,
		updateSnapshot: values.updateSnapshot,
		verbose: values.verbose,
		version: values.version,
		workspace: values.workspace,
		workspaceRoot: values["workspace-root"],
	};
}

export async function run(args: Array<string>): Promise<number> {
	try {
		return await runInner(args);
	} catch (err) {
		printError(err);
		return 2;
	}
}

export async function main(): Promise<void> {
	const exitCode = await run(process.argv.slice(2));
	process.exitCode = exitCode;
}

const PARALLEL_FLAG = "--parallel";
const IntegerLikePattern = /^-?\d+$/;

type ParallelOption = "auto" | number | undefined;

function normalizeParallelFlag(args: Array<string>): Array<string> {
	const out: Array<string> = [];
	for (let index = 0; index < args.length; index++) {
		// eslint-disable-next-line ts/no-non-null-assertion -- index bounded by args.length
		const current = args[index]!;
		if (current !== PARALLEL_FLAG) {
			out.push(current);
			continue;
		}

		const next = args[index + 1];
		const looksLikeValue =
			next !== undefined &&
			!next.startsWith("-") &&
			(next === "auto" || IntegerLikePattern.test(next));
		if (looksLikeValue) {
			out.push(PARALLEL_FLAG, next);
			index += 1;
		} else {
			out.push(PARALLEL_FLAG, "auto");
		}
	}

	return out;
}

function parseParallelValue(raw: string | undefined): ParallelOption {
	if (raw === undefined) {
		return undefined;
	}

	if (raw === "auto") {
		return "auto";
	}

	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed < 1) {
		throw new Error(`Invalid --parallel value "${raw}". Must be a positive integer or "auto".`);
	}

	return parsed;
}

function formatGameOutputLines(raw: string | undefined): string | undefined {
	if (raw === undefined) {
		return undefined;
	}

	const entries = parseGameOutput(raw);
	if (entries.length === 0) {
		return undefined;
	}

	return entries.map((entry) => entry.message.replace(/^/gm, "  ")).join("\n");
}

const EXIT_CODE_MESSAGE = /^Exited with code: \d+$/;

function formatLuauErrorBanner(err: LuauScriptError): string {
	const bannerLines = formatGameOutputLines(err.bannerOutput);

	// When the message is just "Exited with code: N", Jest's real error is in
	// the captured stdout, not in the message itself — surface stdout as the
	// primary content and demote the exit-code transport to a dim footer.
	if (EXIT_CODE_MESSAGE.test(err.message) && bannerLines !== undefined) {
		const body = [bannerLines, `\n  ${color.dim(err.message)}`];
		return formatBanner({ body, level: "error", title: "Test Run Failed" });
	}

	const body = [color.red(err.message)];

	const hint = getLuauErrorHint(err.message);
	if (hint !== undefined) {
		body.push(`\n  ${color.dim("Hint:")} ${hint}`);
	}

	if (bannerLines !== undefined) {
		body.push(`\n  ${color.dim("Game output:")}\n${bannerLines}`);
	}

	return formatBanner({ body, level: "error", title: "Luau Error" });
}

function formatChainExtras(entry: ChainEntry): string {
	const pieces: Array<string> = [];
	if (entry.code !== undefined) {
		pieces.push(`code=${entry.code}`);
	}

	if (entry.errno !== undefined) {
		pieces.push(`errno=${entry.errno}`);
	}

	if (entry.syscall !== undefined) {
		pieces.push(`syscall=${entry.syscall}`);
	}

	return pieces.length > 0 ? color.dim(` (${pieces.join(" ")})`) : "";
}

function formatBackendErrorBanner(err: Error): string {
	const body: Array<string> = [color.red(err.message)];
	const chain = walkErrorChain(err.cause);
	body.push(`\n  ${color.dim("Caused by:")}`);
	for (const [index, entry] of chain.entries()) {
		const extras = formatChainExtras(entry);
		const label = color.dim(`[${index.toString()}]`);
		body.push(`    ${label} ${entry.name}: ${entry.message}${extras}`);
		if (entry.requiredScopes !== undefined) {
			body.push(`        ${color.yellow(formatMissingScopes(entry.requiredScopes))}`);
		}
	}

	return formatBanner({ body, level: "error", title: "Backend Error" });
}

function printError(err: unknown): void {
	if (err instanceof ConfigError) {
		const body = [color.red(err.message)];
		if (err.hint !== undefined) {
			body.push(`\n  ${color.dim("Hint:")} ${err.hint}`);
		}

		process.stderr.write(formatBanner({ body, level: "error", title: "Config Error" }));
	} else if (err instanceof LuauScriptError) {
		process.stderr.write(formatLuauErrorBanner(err));
	} else if (err instanceof Error && err.cause instanceof OpenCloudError) {
		process.stderr.write(formatBackendErrorBanner(err));
	} else if (err instanceof Error) {
		console.error(`Error: ${err.message}`);
	} else {
		console.error("An unknown error occurred");
	}
}

async function dispatchResult(config: ResolvedConfig, result: RunResult): Promise<number> {
	if (result.validationExitCode !== undefined) {
		if ("validationMessage" in result && result.validationMessage !== undefined) {
			process.stderr.write(result.validationMessage);
		}

		return result.validationExitCode;
	}

	if (result.mode === "single") {
		if (result.runtimeResult === undefined && result.typecheckResult === undefined) {
			return 0;
		}

		return outputSingleResult(config, result);
	}

	if (result.projectResults.length === 0 && result.typecheckResult === undefined) {
		return 0;
	}

	return outputMultiResult(config, result);
}

async function runInner(args: Array<string>): Promise<number> {
	const cli = parseArgs(args);

	if (cli.help === true) {
		console.log(HELP_TEXT);
		return 0;
	}

	if (cli.version === true) {
		console.log(VERSION);
		return 0;
	}

	if (process.env["JEST_ROBLOX_SEA"] === "true" && cli.typecheck === true) {
		throw new ConfigError(
			"--typecheck is not available in the standalone binary. Install via npm instead.",
		);
	}

	const loadedConfig = await loadConfig(cli.config, cli.workspaceRoot);
	const config = mergeCliWithConfig(cli, loadedConfig);

	const result = await runJestRoblox(cli, config);
	return dispatchResult(config, result);
}

const LUAU_ERROR_HINTS: Array<[pattern: RegExp, hint: string]> = [
	[
		/Failed to find Jest instance in ReplicatedStorage/,
		'Set "jestPath" in your config to specify the Jest module location, e.g. "ReplicatedStorage/rbxts_include/node_modules/@rbxts/jest/src"',
	],
	[
		/Failed to find Jest instance at path/,
		"The configured jestPath does not resolve to a valid instance. Verify the path matches your Rojo project tree.",
	],
	[
		/Failed to find service/,
		"The first segment of jestPath must be a valid Roblox service name (e.g. ReplicatedStorage, ServerScriptService).",
	],
	[
		/No projects configured/,
		'Set "projects" in jest.config.ts (e.g. ["ReplicatedStorage/client", "ServerScriptService/server"]).',
	],
	[
		/Infinite yield detected/,
		"A :WaitForChild() call is waiting for an instance that doesn't exist. Check your DataModel paths and Rojo project configuration.",
	],
	[
		/loadstring\(\) is not available/,
		'loadstring() must be enabled for Jest to run. Add "LoadStringEnabled": true to ServerScriptService.$properties in your project.json.',
	],
];

function validateBackend(value: string | undefined): Backend | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (!isValidBackend(value)) {
		const valid = [...VALID_BACKENDS].join(", ");
		throw new Error(`Invalid backend "${value}". Must be one of: ${valid}`);
	}

	return value;
}

function getLuauErrorHint(message: string): string | undefined {
	for (const [pattern, hint] of LUAU_ERROR_HINTS) {
		if (pattern.test(message)) {
			return hint;
		}
	}

	return undefined;
}
