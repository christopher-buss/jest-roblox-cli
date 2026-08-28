import { OpenCloudError } from "@bedrock-rbx/ocale";

import process from "node:process";
import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs as nodeParseArgs } from "node:util";
import color from "tinyrainbow";

import packageJson from "../package.json" with { type: "json" };
import type { ParallelOption } from "./backends/interface.ts";
import { ConfigError } from "./config/errors.ts";
import { loadConfig } from "./config/loader.ts";
import { mergeCliWithConfig } from "./config/merge.ts";
import type { Backend, CliOptions, CoverageReporter, ResolvedConfig } from "./config/schema.ts";
import {
	isCoverageReporter,
	isValidBackend,
	VALID_BACKENDS,
	VALID_COVERAGE_REPORTERS,
} from "./config/schema.ts";
import { outputMultiResultAsync } from "./output.ts";
import { createStdoutRunProgress, type RunProgress } from "./progress/reporter.ts";
import { LuauScriptError } from "./reporter/parser.ts";
import { runJestRobloxAsync } from "./run.ts";
import type { MultiRunResult, WorkspaceRunResult } from "./run/types.ts";
import { formatBanner } from "./utils/banner.ts";
import { type ChainEntry, formatMissingScopes, walkErrorChain } from "./utils/error-chain.ts";
import { parseGameOutput } from "./utils/game-output.ts";

const VERSION = packageJson.version;

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
  --bail                            Workspace mode: stop after the first failing package
  --workspace                       Run tests across all workspace packages
  --packages <names>                Comma-separated package names (narrows a workspace run)
  --workspace-root <path>           Directory to load the workspace config from
                                    (use when running outside any package)
  --affected-since <ref>            Run only packages affected since git ref via turbo/nx
  --no-coverage-cache               Force a clean coverage re-instrumentation (skip incremental cache)
  --no-upload-cache                 Always upload the place, even when its bytes are unchanged
  --parallel [n]                    Open-Cloud-only: number of concurrent sessions
                                    (or "auto" = min(jobs, 3); default: 1 session)
  --experimental-vm-parallel [n]    Studio-only, experimental: run the configs across
                                    n Luau VMs in one Studio session (default: one
                                    VM per config; max 4, the hosts the plugin
                                    ships). Game output becomes batch-scoped
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

// `as const` is what keeps the per-flag `type`/`multiple`/`default` literals —
// node's `parseArgs` types derive the shape of `values` from them, so widening
// any of these to `string`/`boolean` would collapse every parsed value to
// `string | boolean | undefined`.
const CLI_OPTION_SPEC = {
	"affected-since": { type: "string" },
	"apiKey": { type: "string" },
	"backend": { type: "string" },
	"bail": { type: "boolean" },
	"collectCoverageFrom": { multiple: true, type: "string" },
	"color": { type: "boolean" },
	"config": { type: "string" },
	"coverage": { type: "boolean" },
	"coverage-cache": { type: "boolean" },
	"coverageDirectory": { type: "string" },
	"coverageReporters": { multiple: true, type: "string" },
	"experimental-vm-parallel": { type: "string" },
	"formatters": { multiple: true, type: "string" },
	"gameOutput": { type: "string" },
	"headed": { type: "boolean" },
	"help": { default: false, type: "boolean" },
	"no-color": { type: "boolean" },
	"no-coverage": { type: "boolean" },
	"no-coverage-cache": { type: "boolean" },
	"no-show-luau": { type: "boolean" },
	"no-upload-cache": { type: "boolean" },
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
	"upload-cache": { type: "boolean" },
	"verbose": { type: "boolean" },
	"version": { default: false, type: "boolean" },
	"workspace": { type: "boolean" },
	"workspace-root": { type: "string" },
} as const satisfies ParseArgsOptionsConfig;

export function parseArgs(args: Array<string>): CliOptions {
	const { positionals, values } = parseWithOptionSpec(args);

	// Spread order matters: `toBackendOptions` and `toCoverageOptions` are the
	// only groups that validate, and they run ahead of the inline `parallel`
	// entry so a run with several bad flags reports the same one it always has.
	return {
		...toBackendOptions(values),
		...toCoverageOptions(values),
		...toFilterOptions(values, positionals),
		...toOutputOptions(values),
		...toTypecheckOptions(values),
		affectedSince: values["affected-since"],
		bail: values.bail,
		config: values.config,
		experimentalVmParallel: parseVmParallelValue(values["experimental-vm-parallel"]),
		help: values.help,
		packages: values.packages,
		parallel: parseParallelValue(values.parallel),
		passWithNoTests: values.passWithNoTests,
		rojoProject: values.rojoProject,
		setupFiles: values.setupFiles,
		setupFilesAfterEnv: values.setupFilesAfterEnv,
		updateSnapshot: values.updateSnapshot,
		uploadCache: values["no-upload-cache"] === true ? false : values["upload-cache"],
		version: values.version,
		workspace: values.workspace,
		workspaceRoot: values["workspace-root"],
	};
}

export async function runAsync(args: Array<string>): Promise<number> {
	try {
		return await runInnerAsync(args);
	} catch (err) {
		printError(err);
		return 2;
	}
}

export async function main(): Promise<void> {
	const exitCode = await runAsync(process.argv.slice(2));
	process.exitCode = exitCode;
}

const PARALLEL_FLAG = "--parallel";
const VM_PARALLEL_FLAG = "--experimental-vm-parallel";
const INTEGER_LIKE_PATTERN = /^-?\d+$/;

/**
 * The flags whose value is optional: `--parallel` and
 * `--experimental-vm-parallel` both mean "pick the count for me" when written
 * bare. `parseArgs` has no optional-value mode, so the bare form is rewritten
 * to an explicit `auto` before it gets there.
 *
 * `isValueLike` decides what counts as this flag's value rather than the next
 * argument: anything else (a following flag, a positional test path) leaves
 * the flag bare.
 */
const OPTIONAL_VALUE_FLAGS: ReadonlyArray<{
	isValueLike: (next: string) => boolean;
	name: string;
}> = [
	{
		name: PARALLEL_FLAG,
		isValueLike: (next) => next === "auto" || INTEGER_LIKE_PATTERN.test(next),
	},
	{
		name: VM_PARALLEL_FLAG,
		isValueLike: (next) => next === BARE_FLAG_VALUE || INTEGER_LIKE_PATTERN.test(next),
	},
];

const BARE_FLAG_VALUE = "auto";

interface CliParseConfig {
	allowPositionals: true;
	args: Array<string>;
	options: typeof CLI_OPTION_SPEC;
	strict: true;
}

type ParsedCliValues = ReturnType<typeof parseWithOptionSpec>["values"];

function normalizeOptionalValueFlags(args: Array<string>): Array<string> {
	const out: Array<string> = [];
	for (let index = 0; index < args.length; index++) {
		// eslint-disable-next-line ts/no-non-null-assertion -- index bounded by args.length
		const current = args[index]!;
		const flag = OPTIONAL_VALUE_FLAGS.find((entry) => entry.name === current);
		if (flag === undefined) {
			out.push(current);
			continue;
		}

		const next = args[index + 1];
		if (next !== undefined && !next.startsWith("-") && flag.isValueLike(next)) {
			out.push(flag.name, next);
			index += 1;
		} else {
			out.push(flag.name, BARE_FLAG_VALUE);
		}
	}

	return out;
}

function parseWithOptionSpec(
	args: Array<string>,
): ReturnType<typeof nodeParseArgs<CliParseConfig>> {
	return nodeParseArgs({
		allowPositionals: true,
		args: normalizeOptionalValueFlags(args),
		options: CLI_OPTION_SPEC,
		strict: true,
	});
}

function toBackendOptions(
	values: ParsedCliValues,
): Pick<
	CliOptions,
	"apiKey" | "backend" | "headed" | "placeId" | "port" | "studioPath" | "timeout" | "universeId"
> {
	return {
		apiKey: values.apiKey,
		backend: validateBackend(values.backend),
		headed: values.headed,
		placeId: values.placeId,
		port: values.port !== undefined ? Number.parseInt(values.port, 10) : undefined,
		studioPath: values.studioPath,
		timeout: values.timeout !== undefined ? Number.parseInt(values.timeout, 10) : undefined,
		universeId: values.universeId,
	};
}

function toCoverageOptions(
	values: ParsedCliValues,
): Pick<
	CliOptions,
	| "collectCoverage"
	| "collectCoverageFrom"
	| "coverageCache"
	| "coverageDirectory"
	| "coverageReporters"
> {
	return {
		collectCoverage: values["no-coverage"] === true ? false : values.coverage,
		collectCoverageFrom: values.collectCoverageFrom,
		coverageCache: values["no-coverage-cache"] === true ? false : values["coverage-cache"],
		coverageDirectory: values.coverageDirectory,
		coverageReporters: validateCoverageReporters(values.coverageReporters),
	};
}

function toFilterOptions(
	values: ParsedCliValues,
	positionals: Array<string>,
): Pick<CliOptions, "files" | "project" | "testNamePattern" | "testPathPattern"> {
	return {
		files: positionals.length > 0 ? positionals : undefined,
		project: values.project,
		testNamePattern: values.testNamePattern,
		testPathPattern: values.testPathPattern,
	};
}

function toOutputOptions(
	values: ParsedCliValues,
): Pick<
	CliOptions,
	| "color"
	| "formatters"
	| "gameOutput"
	| "outputFile"
	| "showLuau"
	| "silent"
	| "sourceMap"
	| "verbose"
> {
	return {
		color: values["no-color"] === true ? false : values.color,
		formatters: values.formatters,
		gameOutput: values.gameOutput,
		outputFile: values.outputFile,
		showLuau: values["no-show-luau"] === true ? false : values.showLuau,
		silent: values.silent,
		sourceMap: values.sourceMap,
		verbose: values.verbose,
	};
}

function toTypecheckOptions(
	values: ParsedCliValues,
): Pick<CliOptions, "typecheck" | "typecheckOnly" | "typecheckTsconfig"> {
	return {
		typecheck: values.typecheckOnly === true ? true : values.typecheck,
		typecheckOnly: values.typecheckOnly,
		typecheckTsconfig: values.typecheckTsconfig,
	};
}

function parseParallelValue(raw: string | undefined): ParallelOption {
	if (raw === undefined) {
		return undefined;
	}

	if (raw === "auto") {
		return "auto";
	}

	if (!INTEGER_LIKE_PATTERN.test(raw)) {
		throw new Error(`Invalid --parallel value "${raw}". Must be a positive integer or "auto".`);
	}

	const parsed = Number(raw);
	if (parsed < 1) {
		throw new Error(`Invalid --parallel value "${raw}". Must be a positive integer or "auto".`);
	}

	return parsed;
}

/**
 * `--experimental-vm-parallel [n]`: how many Luau VMs the Studio plugin splits
 * the run's configs across. Bare — or the `auto` the bare form is rewritten to,
 * which a user may also type — means one VM per config; an explicit count must
 * be a positive integer, and the plugin clamps it to the configs it was given
 * and the hosts it ships.
 */
function parseVmParallelValue(raw: string | undefined): ParallelOption {
	if (raw === undefined) {
		return undefined;
	}

	if (raw === BARE_FLAG_VALUE) {
		return "auto";
	}

	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed < 1) {
		throw new Error(`Invalid ${VM_PARALLEL_FLAG} value "${raw}". Must be a positive integer.`);
	}

	return parsed;
}

function formatGameOutputLines(raw: string | undefined): string | undefined {
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
	if (bannerLines !== undefined && EXIT_CODE_MESSAGE.test(err.message)) {
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

/**
 * How much of a captured response body the banner shows. A parse failure hands
 * over 500 bytes of minified JSON; the opening object keys are what name the
 * call that returned it, and the rest only buries the cause chain below it.
 */
const BODY_PREVIEW_LIMIT = 160;

function formatChainExtras(entry: ChainEntry): string {
	const pieces: Array<string> = [];
	if (entry.statusCode !== undefined) {
		pieces.push(`status=${entry.statusCode.toString()}`);
	}

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

/**
 * One-line preview of a captured response body. Whitespace is collapsed so a
 * body that is itself several lines cannot push the rest of the chain off the
 * screen.
 */
function formatBodyPreview(details: string | undefined): string | undefined {
	if (details === undefined) {
		return undefined;
	}

	const collapsed = details.replaceAll(/\s+/gu, " ").trim();
	if (collapsed === "") {
		return undefined;
	}

	return collapsed.length > BODY_PREVIEW_LIMIT
		? `${collapsed.slice(0, BODY_PREVIEW_LIMIT)}…`
		: collapsed;
}

/**
 * The indented lines that hang under one chain entry. Each appears only when
 * the error carried it: ocale names the failing request on an error response
 * but not on a 2xx body it could not parse, where the body head is the only
 * thing that says which call returned it.
 */
function formatChainDetailLines(entry: ChainEntry): Array<string> {
	const lines: Array<string> = [];
	if (entry.url !== undefined) {
		const method = entry.method === undefined ? "" : `${entry.method} `;
		const request = color.dim(`${method}${entry.url}`);
		lines.push(`        ${request}`);
	}

	const preview = formatBodyPreview(entry.details);
	if (preview !== undefined) {
		lines.push(`        ${color.dim("Body:")} ${preview}`);
	}

	if (entry.requiredScopes !== undefined) {
		lines.push(`        ${color.yellow(formatMissingScopes(entry.requiredScopes))}`);
	}

	return lines;
}

function formatBackendErrorBanner(err: Error): string {
	const body: Array<string> = [color.red(err.message)];
	const chain = walkErrorChain(err.cause);
	body.push(`\n  ${color.dim("Caused by:")}`);
	for (const [index, entry] of chain.entries()) {
		const extras = formatChainExtras(entry);
		const label = color.dim(`[${index.toString()}]`);
		body.push(
			`    ${label} ${entry.name}: ${entry.message}${extras}`,
			...formatChainDetailLines(entry),
		);
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

async function dispatchResultAsync(
	config: ResolvedConfig,
	result: MultiRunResult | WorkspaceRunResult,
	progress: RunProgress,
): Promise<number> {
	if (result.validationExitCode !== undefined) {
		if (result.validationMessage !== undefined) {
			process.stderr.write(result.validationMessage);
		}

		return result.validationExitCode;
	}

	if (result.projectResults.length === 0 && result.typecheckResult === undefined) {
		return 0;
	}

	return outputMultiResultAsync(config, result, progress);
}

async function runInnerAsync(args: Array<string>): Promise<number> {
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

	// The CLI owns the terminal for the whole invocation, so it owns the stage
	// block: the run is only part of it, and the coverage merge and report the
	// user waits on just as long come after the run returns. Settled in a
	// `finally`, so a throw leaves the block naming the step it died inside.
	const progress = createStdoutRunProgress();
	try {
		const result = await runJestRobloxAsync(cli, config, progress);
		return await dispatchResultAsync(config, result, progress);
	} finally {
		progress.finish();
	}
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

function validateCoverageReporters(
	values: Array<string> | undefined,
): Array<CoverageReporter> | undefined {
	if (values === undefined) {
		return undefined;
	}

	const reporters = values.filter(isCoverageReporter);
	if (reporters.length !== values.length) {
		const valid = [...VALID_COVERAGE_REPORTERS].join(", ");
		const unknown = values.filter((value) => !isCoverageReporter(value));
		throw new Error(
			`Invalid coverage reporter "${unknown.join('", "')}". Must be one of: ${valid}`,
		);
	}

	return reporters;
}

function getLuauErrorHint(message: string): string | undefined {
	for (const [pattern, hint] of LUAU_ERROR_HINTS) {
		if (pattern.test(message)) {
			return hint;
		}
	}

	return undefined;
}
