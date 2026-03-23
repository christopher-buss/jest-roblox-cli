import { type } from "arktype";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { parseArgs as nodeParseArgs } from "node:util";
import { isAgent } from "std-env";
import color from "tinyrainbow";

import packageJson from "../package.json" with { type: "json" };
import { resolveBackend } from "./backends/auto.ts";
import { ConfigError } from "./config/errors.ts";
import { loadConfig } from "./config/loader.ts";
import type { ResolvedProjectConfig } from "./config/projects.ts";
import { resolveAllProjects } from "./config/projects.ts";
import type {
	Backend,
	CliOptions,
	CoverageReporter,
	FormatterEntry,
	ProjectEntry,
	ProjectTestConfig,
	ResolvedConfig,
} from "./config/schema.ts";
import { isValidBackend, ROOT_ONLY_KEYS, VALID_BACKENDS } from "./config/schema.ts";
import { createSetupResolver } from "./config/setup-resolver.ts";
import { generateProjectConfigs, syncStubsToShadowDirectory } from "./config/stubs.ts";
import { mapCoverageToTypeScript } from "./coverage/mapper.ts";
import { prepareCoverage } from "./coverage/prepare.ts";
import { checkThresholds, generateReports, printCoverageHeader } from "./coverage/reporter.ts";
import { buildWithRojo } from "./coverage/rojo-builder.ts";
import type { RawCoverageData } from "./coverage/types.ts";
import {
	execute,
	type ExecuteResult,
	formatExecuteOutput,
	loadCoverageManifest,
} from "./executor.ts";
import { formatCompactMultiProject } from "./formatters/compact.ts";
import {
	formatMultiProjectResult,
	formatResult,
	type FormatterProjectEntry,
	formatTypecheckSummary,
} from "./formatters/formatter.ts";
import {
	formatAnnotations,
	formatJobSummary,
	type GitHubActionsFormatterOptions,
	resolveGitHubActionsOptions,
} from "./formatters/github-actions.ts";
import { writeJsonFile } from "./formatters/json.ts";
import { DEFAULT_MAX_FAILURES, findFormatterOptions } from "./formatters/utils.ts";
import { LuauScriptError } from "./reporter/parser.ts";
import type { SourceMapper } from "./source-mapper/index.ts";
import { runTypecheck } from "./typecheck/runner.ts";
import type { JestResult } from "./types/jest-result.ts";
import { rojoProjectSchema } from "./types/rojo.ts";
import type { RojoTreeNode } from "./types/rojo.ts";
import type { TimingResult } from "./types/timing.ts";
import { formatBanner } from "./utils/banner.ts";
import { formatGameOutputNotice, parseGameOutput, writeGameOutput } from "./utils/game-output.ts";
import { globSync } from "./utils/glob.ts";

const VERSION: string = packageJson.version;

const DEFAULT_ROJO_PROJECT = "default.project.json";
const TYPE_TEST_PATTERN = /\.(test-d|spec-d)\.ts$/;

const HELP_TEXT = `
Usage: jest-roblox [options] [files...]

Options:
  --backend <type>                  Backend: "auto", "open-cloud", or "studio" (default: auto)
  --port <number>                   WebSocket port for studio backend (default: 3001)
  --config <path>                   Path to config file
  --testPathPattern <regex>         Filter test files by path pattern
  -t, --testNamePattern <regex>     Filter tests by name pattern
  --outputFile <path>               Write results to file
  --gameOutput <path>               Write game output (print/warn/error) to file
  --sourceMap                       Map Luau stack traces to TypeScript source
  --rojoProject <path>              Path to rojo project file (auto-detected if not set)
  --verbose                         Show individual test results
  --silent                          Suppress output
  --no-color                        Disable colored output
  -u, --updateSnapshot              Update snapshot files
  --coverage                        Enable coverage collection
  --coverageDirectory <path>        Directory for coverage output (default: coverage)
  --coverageReporters <r...>        Coverage reporters (default: text, lcov)
  --formatters <name...>            Output formatters (default, agent, json, github-actions)
  --no-cache                        Force re-upload place file (skip cache)
  --pollInterval <ms>               Open Cloud poll interval in ms (default: 500)
  --project <name...>               Filter which named projects to run
  --setupFiles <path...>            Setup scripts (package specifiers or relative paths)
  --setupFilesAfterEnv <path...>    Post-env setup scripts (package specifiers or relative paths)
  --no-show-luau                    Hide Luau code in failure output
  --typecheck                       Enable type testing (*.test-d.ts, *.spec-d.ts)
  --typecheckOnly                   Run only type tests, skip runtime tests
  --typecheckTsconfig <path>        tsconfig for type testing
  --help                            Show this help message
  --version                         Show version number

Environment Variables (open-cloud backend only):
  ROBLOX_OPEN_CLOUD_API_KEY  API key for Roblox Open Cloud
  ROBLOX_UNIVERSE_ID         Target universe ID
  ROBLOX_PLACE_ID            Target place ID

Examples:
  jest-roblox                         Run all tests (open-cloud)
  jest-roblox --backend studio        Run tests via Studio plugin
  jest-roblox src/player.spec.ts      Run specific test file
  jest-roblox -t "should spawn"       Run tests matching pattern
  jest-roblox --formatters json       Output JSON to file
  jest-roblox --coverage              Run tests with coverage instrumentation
`;

interface ProjectResult {
	displayColor?: string;
	displayName: string;
	result: ExecuteResult;
}

interface FormattedOutputOptions {
	config: ResolvedConfig;
	mergedResult: JestResult;
	runtimeResult?: ExecuteResult;
	timing?: TimingResult;
	typecheckResult?: JestResult;
}

interface MultiProjectOutputOptions {
	config: ResolvedConfig;
	merged: ExecuteResult;
	preCoverageMs: number;
	projectResults: Array<ProjectResult>;
	typecheckResult: JestResult | undefined;
}

export function parseArgs(args: Array<string>): CliOptions {
	const { positionals, values } = nodeParseArgs({
		allowPositionals: true,
		args,
		options: {
			"backend": { type: "string" },
			"cache": { type: "boolean" },
			"color": { type: "boolean" },
			"config": { type: "string" },
			"coverage": { type: "boolean" },
			"coverageDirectory": { type: "string" },
			"coverageReporters": { multiple: true, type: "string" },
			"formatters": { multiple: true, type: "string" },
			"gameOutput": { type: "string" },
			"help": { default: false, type: "boolean" },
			"no-cache": { type: "boolean" },
			"no-color": { type: "boolean" },
			"no-show-luau": { type: "boolean" },
			"outputFile": { type: "string" },
			"pollInterval": { type: "string" },
			"port": { type: "string" },
			"project": { multiple: true, type: "string" },
			"rojoProject": { type: "string" },
			"setupFiles": { multiple: true, type: "string" },
			"setupFilesAfterEnv": { multiple: true, type: "string" },
			"showLuau": { type: "boolean" },
			"silent": { type: "boolean" },
			"sourceMap": { type: "boolean" },
			"testNamePattern": { short: "t", type: "string" },
			"testPathPattern": { type: "string" },
			"timeout": { type: "string" },
			"typecheck": { type: "boolean" },
			"typecheckOnly": { type: "boolean" },
			"typecheckTsconfig": { type: "string" },
			"updateSnapshot": { short: "u", type: "boolean" },
			"verbose": { type: "boolean" },
			"version": { default: false, type: "boolean" },
		},
		strict: true,
	});

	const pollInterval =
		values.pollInterval !== undefined ? Number.parseInt(values.pollInterval, 10) : undefined;

	const port = values.port !== undefined ? Number.parseInt(values.port, 10) : undefined;

	const timeout = values.timeout !== undefined ? Number.parseInt(values.timeout, 10) : undefined;

	return {
		backend: validateBackend(values.backend),
		cache: values["no-cache"] === true ? false : values.cache,
		collectCoverage: values.coverage,
		color: values["no-color"] === true ? false : values.color,
		config: values.config,
		coverageDirectory: values.coverageDirectory,
		coverageReporters: values.coverageReporters as Array<CoverageReporter> | undefined,
		files: positionals.length > 0 ? positionals : undefined,
		formatters: values.formatters,
		gameOutput: values.gameOutput,
		help: values.help,
		outputFile: values.outputFile,
		pollInterval,
		port,
		project: values.project,
		rojoProject: values.rojoProject,
		setupFiles: values.setupFiles,
		setupFilesAfterEnv: values.setupFilesAfterEnv,
		showLuau: values["no-show-luau"] === true ? false : values.showLuau,
		silent: values.silent,
		sourceMap: values.sourceMap,
		testNamePattern: values.testNamePattern,
		testPathPattern: values.testPathPattern,
		timeout,
		typecheck: values.typecheckOnly === true ? true : values.typecheck,
		typecheckOnly: values.typecheckOnly,
		typecheckTsconfig: values.typecheckTsconfig,
		updateSnapshot: values.updateSnapshot,
		verbose: values.verbose,
		version: values.version,
	};
}

export function filterByName(
	projects: Array<ResolvedProjectConfig>,
	names: Array<string>,
): Array<ResolvedProjectConfig> {
	const available = new Set(projects.map((project) => project.displayName));
	const unknown = names.filter((name) => !available.has(name));
	if (unknown.length > 0) {
		throw new Error(
			`Unknown project name(s): ${unknown.join(", ")}. Available: ${[...available].join(", ")}`,
		);
	}

	const nameSet = new Set(names);
	return projects.filter((project) => nameSet.has(project.displayName));
}

export function mergeProjectResults(results: Array<ExecuteResult>): ExecuteResult {
	assert(results.length > 0, "mergeProjectResults requires at least one result");

	if (results.length === 1) {
		// Safe: length checked above
		const [first] = results as [ExecuteResult];
		return first;
	}

	let numberFailedTests = 0;
	let numberPassedTests = 0;
	let numberPendingTests = 0;
	let numberTodoTests = 0;
	let numberTotalTests = 0;
	let startTime = Number.POSITIVE_INFINITY;
	let success = true;
	const testResults: Array<JestResult["testResults"][number]> = [];
	let executionMs = 0;
	let testsMs = 0;
	let totalMs = 0;
	let uploadMs = 0;
	let coverageMs = 0;
	let mergedCoverage: RawCoverageData | undefined;

	for (const result of results) {
		numberFailedTests += result.result.numFailedTests;
		numberPassedTests += result.result.numPassedTests;
		numberPendingTests += result.result.numPendingTests;
		numberTodoTests += result.result.numTodoTests ?? 0;
		numberTotalTests += result.result.numTotalTests;
		startTime = Math.min(startTime, result.result.startTime);
		success &&= result.result.success;
		testResults.push(...result.result.testResults);
		executionMs += result.timing.executionMs;
		testsMs += result.timing.testsMs;
		totalMs += result.timing.totalMs;
		uploadMs += result.timing.uploadMs ?? 0;
		coverageMs += result.timing.coverageMs ?? 0;
		if (result.coverageData !== undefined) {
			mergedCoverage = { ...mergedCoverage, ...result.coverageData };
		}
	}

	return {
		coverageData: mergedCoverage,
		exitCode: success ? 0 : 1,
		output: "",
		result: {
			numFailedTests: numberFailedTests,
			numPassedTests: numberPassedTests,
			numPendingTests: numberPendingTests,
			numTodoTests: numberTodoTests,
			numTotalTests: numberTotalTests,
			startTime,
			success,
			testResults,
		},
		timing: {
			coverageMs: coverageMs > 0 ? coverageMs : undefined,
			executionMs,
			startTime: Math.min(...results.map((result) => result.timing.startTime)),
			testsMs,
			totalMs,
			uploadCached: results.every((result) => result.timing.uploadCached === true),
			uploadMs,
		},
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
	process.exit(exitCode);
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

function printError(err: unknown): void {
	if (err instanceof ConfigError) {
		const body = [color.red(err.message)];
		if (err.hint !== undefined) {
			body.push(`\n  ${color.dim("Hint:")} ${err.hint}`);
		}

		process.stderr.write(formatBanner({ body, level: "error", title: "Config Error" }));
	} else if (err instanceof LuauScriptError) {
		const body = [color.red(err.message)];

		const hint = getLuauErrorHint(err.message);
		if (hint !== undefined) {
			body.push(`\n  ${color.dim("Hint:")} ${hint}`);
		}

		const gameLines = formatGameOutputLines(err.gameOutput);
		if (gameLines !== undefined) {
			body.push(`\n  ${color.dim("Game output:")}\n${gameLines}`);
		}

		process.stderr.write(formatBanner({ body, level: "error", title: "Luau Error" }));
	} else if (err instanceof Error) {
		console.error(`Error: ${err.message}`);
	} else {
		console.error("An unknown error occurred");
	}
}

function writeGameOutputIfConfigured(
	config: ResolvedConfig,
	gameOutput: string | undefined,
	options: { hintsShown?: boolean },
): void {
	if (config.gameOutput === undefined) {
		return;
	}

	const entries = parseGameOutput(gameOutput);
	writeGameOutput(config.gameOutput, entries);

	if (!config.silent && options.hintsShown !== true) {
		const notice = formatGameOutputNotice(config.gameOutput, entries.length);
		if (notice) {
			console.error(notice);
		}
	}
}

function printFinalStatus(passed: boolean): void {
	const badge = passed
		? color.bgGreen(color.black(color.bold(" PASS ")))
		: color.bgRed(color.white(color.bold(" FAIL ")));
	process.stdout.write(`${badge}\n`);
}

function processCoverage(
	config: ResolvedConfig,
	coverageData: RawCoverageData | undefined,
): boolean {
	if (!config.collectCoverage || coverageData === undefined) {
		return true;
	}

	const manifest = loadCoverageManifest(config.rootDir);
	if (manifest === undefined) {
		if (!config.silent) {
			process.stderr.write("Warning: Coverage manifest not found, skipping TS mapping\n");
		}

		return true;
	}

	const mapped = mapCoverageToTypeScript(coverageData, manifest);

	const coverageDirectory = path.resolve(config.rootDir, config.coverageDirectory);

	if (!config.silent) {
		printCoverageHeader();
	}

	// Always generate reports (even in silent mode) so CI can collect artifacts
	generateReports({
		coverageDirectory,
		mapped,
		reporters: config.coverageReporters,
	});

	if (config.coverageThreshold !== undefined) {
		const result = checkThresholds(mapped, config.coverageThreshold);
		if (!result.passed) {
			for (const failure of result.failures) {
				process.stderr.write(
					`Coverage threshold not met for ${failure.metric}: ${String(failure.actual.toFixed(2))}% < ${String(failure.threshold)}%\n`,
				);
			}

			return false;
		}
	}

	return true;
}

function runGitHubActionsFormatter(
	config: ResolvedConfig,
	result: JestResult,
	sourceMapper: SourceMapper | undefined,
): void {
	assert(config.formatters !== undefined, "formatters is set by resolveFormatters");
	const userOptions = findFormatterOptions(config.formatters, "github-actions");
	if (userOptions === undefined) {
		return;
	}

	const typedOptions = userOptions as GitHubActionsFormatterOptions;
	const options = resolveGitHubActionsOptions(typedOptions, sourceMapper);

	if (typedOptions.displayAnnotations !== false) {
		const annotations = formatAnnotations(result, options);
		if (annotations !== "") {
			process.stderr.write(`${annotations}\n`);
		}
	}

	const { jobSummary } = typedOptions;
	if (jobSummary?.enabled !== false) {
		const outputPath = jobSummary?.outputPath ?? process.env["GITHUB_STEP_SUMMARY"];
		if (outputPath !== undefined) {
			const summary = formatJobSummary(result, options);
			fs.appendFileSync(outputPath, summary);
		}
	}
}

function hasFormatter(config: ResolvedConfig, name: string): boolean {
	return (
		config.formatters?.some((entry) =>
			Array.isArray(entry) ? entry[0] === name : entry === name,
		) === true
	);
}

function getCompactMaxFailures(config: ResolvedConfig): number {
	assert(config.formatters !== undefined, "formatters is set by resolveFormatters");
	const options = findFormatterOptions(config.formatters, "agent");
	if (options !== undefined && typeof options["maxFailures"] === "number") {
		return options["maxFailures"];
	}

	return DEFAULT_MAX_FAILURES;
}

function usesAgentFormatter(config: ResolvedConfig): boolean {
	return hasFormatter(config, "agent") && !config.verbose;
}

function usesDefaultFormatter(config: ResolvedConfig): boolean {
	return !hasFormatter(config, "json") && !usesAgentFormatter(config);
}

function printOutput(output: string): void {
	if (output !== "") {
		console.log(output);
	}
}

function formatRuntimeOutput(
	config: ResolvedConfig,
	runtimeResult: ExecuteResult,
	timing: TimingResult,
): string {
	return formatExecuteOutput({
		config,
		result: runtimeResult.result,
		sourceMapper: runtimeResult.sourceMapper,
		timing,
		version: VERSION,
	});
}

function printFormattedOutput(options: FormattedOutputOptions): void {
	const { config, mergedResult, runtimeResult, timing, typecheckResult } = options;

	// Typecheck + runtime: merge into single output for default formatter,
	// otherwise use runtime formatter + separate typecheck summary.
	if (typecheckResult !== undefined && runtimeResult !== undefined && timing !== undefined) {
		if (usesDefaultFormatter(config)) {
			printOutput(
				formatResult(mergedResult, timing, {
					collectCoverage: config.collectCoverage,
					color: config.color,
					rootDir: config.rootDir,
					showLuau: config.showLuau,
					sourceMapper: runtimeResult.sourceMapper,
					typeErrors: typecheckResult.numFailedTests,
					verbose: config.verbose,
					version: VERSION,
				}),
			);
		} else {
			printOutput(formatRuntimeOutput(config, runtimeResult, timing));
			process.stderr.write(formatTypecheckSummary(typecheckResult));
		}

		return;
	}

	if (typecheckResult !== undefined) {
		process.stdout.write(formatTypecheckSummary(typecheckResult));
		return;
	}

	// Runtime-only: guaranteed by outputResults which requires at least one
	// result.
	assert(runtimeResult !== undefined && timing !== undefined, "runtime result required");
	printOutput(formatRuntimeOutput(config, runtimeResult, timing));
}

function addCoverageTiming(timing: TimingResult, coverageMs: number): TimingResult {
	return { ...timing, coverageMs, totalMs: timing.totalMs + coverageMs };
}

async function outputResults(
	config: ResolvedConfig,
	typecheckResult: JestResult | undefined,
	runtimeResult: ExecuteResult | undefined,
	preCoverageMs: number,
): Promise<number> {
	const mergedResult = mergeResults(typecheckResult, runtimeResult?.result);

	if (!config.silent) {
		const timing =
			runtimeResult !== undefined
				? addCoverageTiming(runtimeResult.timing, preCoverageMs)
				: undefined;
		printFormattedOutput({ config, mergedResult, runtimeResult, timing, typecheckResult });
	}

	const coveragePassed = processCoverage(config, runtimeResult?.coverageData);

	if (config.outputFile !== undefined) {
		await writeJsonFile(mergedResult, config.outputFile);
	}

	if (runtimeResult !== undefined) {
		writeGameOutputIfConfigured(config, runtimeResult.gameOutput, {
			hintsShown: !mergedResult.success,
		});
	}

	runGitHubActionsFormatter(config, mergedResult, runtimeResult?.sourceMapper);

	const passed = mergedResult.success && coveragePassed;

	if (!config.silent && config.collectCoverage) {
		printFinalStatus(passed);
	}

	return passed ? 0 : 1;
}

function toProjectEntries(projectResults: Array<ProjectResult>): Array<FormatterProjectEntry> {
	return projectResults.map((pr) => {
		return {
			displayColor: pr.displayColor,
			displayName: pr.displayName,
			result: pr.result.result,
		};
	});
}

function printMultiProjectOutput(options: MultiProjectOutputOptions): void {
	const { config, merged, preCoverageMs, projectResults, typecheckResult } = options;
	const timing = addCoverageTiming(merged.timing, preCoverageMs);

	if (usesAgentFormatter(config)) {
		printOutput(
			formatCompactMultiProject(toProjectEntries(projectResults), {
				gameOutput: config.gameOutput,
				maxFailures: getCompactMaxFailures(config),
				outputFile: config.outputFile,
				rootDir: config.rootDir,
				sourceMapper: merged.sourceMapper,
				typeErrorCount: typecheckResult?.numFailedTests,
			}),
		);
		return;
	}

	if (hasFormatter(config, "json")) {
		printOutput(formatRuntimeOutput(config, merged, timing));
		return;
	}

	printOutput(
		formatMultiProjectResult(toProjectEntries(projectResults), timing, {
			collectCoverage: config.collectCoverage,
			color: config.color,
			rootDir: config.rootDir,
			showLuau: config.showLuau,
			sourceMapper: merged.sourceMapper,
			typeErrors: typecheckResult?.numFailedTests,
			verbose: config.verbose,
			version: VERSION,
		}),
	);
}

async function outputMultiProjectResults(
	config: ResolvedConfig,
	projectResults: Array<ProjectResult>,
	typecheckResult: JestResult | undefined,
	preCoverageMs: number,
): Promise<number> {
	const merged = mergeProjectResults(projectResults.map((pr) => pr.result));
	const mergedResult = mergeResults(typecheckResult, merged.result);

	if (!config.silent) {
		printMultiProjectOutput({ config, merged, preCoverageMs, projectResults, typecheckResult });

		if (typecheckResult !== undefined && !usesDefaultFormatter(config)) {
			process.stderr.write(formatTypecheckSummary(typecheckResult));
		}
	}

	const coveragePassed = processCoverage(config, merged.coverageData);

	if (config.outputFile !== undefined) {
		await writeJsonFile(mergedResult, config.outputFile);
	}

	runGitHubActionsFormatter(config, mergedResult, merged.sourceMapper);

	const passed = mergedResult.success && coveragePassed;

	if (!config.silent && config.collectCoverage) {
		printFinalStatus(passed);
	}

	return passed ? 0 : 1;
}

function loadRojoTree(config: ResolvedConfig): RojoTreeNode {
	const rojoPath = path.resolve(config.rootDir, config.rojoProject ?? DEFAULT_ROJO_PROJECT);
	const content = fs.readFileSync(rojoPath, "utf8");
	const parsed: unknown = JSON.parse(content);
	const validated = rojoProjectSchema(parsed);
	if (validated instanceof type.errors) {
		throw new Error(`Invalid Rojo project: ${validated.summary}`);
	}

	return validated.tree;
}

// Keys excluded from Luau stubs — these are TS-side/structural config, not
// meaningful in the generated jest.config.lua (separate from SKIP_FIELDS in
// serializeToLuau which handles include/exclude).
const STUB_SKIP_KEYS = new Set(["outDir", "projects", "root"]);

function buildStubConfig(config: ResolvedConfig): Partial<ProjectTestConfig> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		if (!ROOT_ONLY_KEYS.has(key) && !STUB_SKIP_KEYS.has(key) && value !== undefined) {
			result[key] = value;
		}
	}

	return result as Partial<ProjectTestConfig>;
}

function generateProjectStubs(projects: Array<ResolvedProjectConfig>, rootDirectory: string): void {
	const entries: Array<{ config: ProjectTestConfig; outputPath: string }> = [];

	for (const project of projects) {
		if (project.outDir === undefined) {
			continue;
		}

		const outputPath = path.resolve(rootDirectory, project.outDir, "jest.config.lua");
		const stubConfig: ProjectTestConfig = {
			...buildStubConfig(project.config),
			displayName: project.displayName,
			include: [],
			testMatch: project.testMatch,
		};
		entries.push({ config: stubConfig, outputPath });
	}

	generateProjectConfigs(entries);
}

function prepareMultiProjectCoverage(
	rootConfig: ResolvedConfig,
	projects: Array<ResolvedProjectConfig>,
): {
	effectiveConfig: ResolvedConfig;
	preCoverageMs: number;
} {
	if (!rootConfig.collectCoverage) {
		return { effectiveConfig: rootConfig, preCoverageMs: 0 };
	}

	const start = Date.now();
	const { placeFile } = prepareCoverage(rootConfig, (shadowDirectory) => {
		return syncStubsToShadowDirectory(projects, rootConfig.rootDir, shadowDirectory);
	});
	return {
		effectiveConfig: { ...rootConfig, placeFile },
		preCoverageMs: Date.now() - start,
	};
}

function classifyTestFiles(
	files: Array<string>,
	config: ResolvedConfig,
): { runtimeFiles: Array<string>; typeTestFiles: Array<string> } {
	const typeTestFiles = config.typecheck
		? files.filter((file) => TYPE_TEST_PATTERN.test(file))
		: [];
	const runtimeFiles = config.typecheckOnly
		? []
		: files.filter((file) => !TYPE_TEST_PATTERN.test(file));
	return { runtimeFiles, typeTestFiles };
}

function applySetupResolver(
	config: Pick<ResolvedConfig, "setupFiles" | "setupFilesAfterEnv">,
	resolve: (input: string) => string,
): void {
	if (config.setupFiles !== undefined) {
		config.setupFiles = config.setupFiles.map(resolve);
	}

	if (config.setupFilesAfterEnv !== undefined) {
		config.setupFilesAfterEnv = config.setupFilesAfterEnv.map(resolve);
	}
}

async function runMultiProject(
	cli: CliOptions,
	rootConfig: ResolvedConfig,
	projectEntries: Array<ProjectEntry>,
): Promise<number> {
	const rojoTree = loadRojoTree(rootConfig);

	const allProjects = await resolveAllProjects(
		projectEntries,
		rootConfig,
		rojoTree,
		rootConfig.rootDir,
	);

	// Resolve per-project setupFiles/setupFilesAfterEnv
	const rojoConfigPath = path.resolve(
		rootConfig.rootDir,
		rootConfig.rojoProject ?? DEFAULT_ROJO_PROJECT,
	);
	const resolveSetup = createSetupResolver({
		configDirectory: rootConfig.rootDir,
		rojoConfigPath,
	});
	for (const project of allProjects) {
		applySetupResolver(project.config, resolveSetup);
	}

	const projects =
		cli.project !== undefined ? filterByName(allProjects, cli.project) : allProjects;

	generateProjectStubs(projects, rootConfig.rootDir);

	// When coverage is enabled, prepareCoverage handles the build (with stubs
	// synced into the shadow dir). Only build here for the non-coverage path.
	if (!rootConfig.collectCoverage) {
		const rojoProjectPath = path.resolve(
			rootConfig.rootDir,
			rootConfig.rojoProject ?? DEFAULT_ROJO_PROJECT,
		);
		const placeFilePath = path.resolve(rootConfig.rootDir, rootConfig.placeFile);
		buildWithRojo(rojoProjectPath, placeFilePath);
	}

	const { effectiveConfig, preCoverageMs } = prepareMultiProjectCoverage(rootConfig, projects);
	const backend = await resolveBackend(effectiveConfig);

	const projectResults: Array<ProjectResult> = [];
	const allTypeTestFiles: Array<string> = [];

	for (const project of projects) {
		// Use original include patterns (with TS extensions) for FS discovery
		const discoveryConfig: ResolvedConfig = {
			...project.config,
			placeFile: effectiveConfig.placeFile,
			projects: project.projects,
			testMatch: project.include,
		};

		const discovery = discoverTestFiles(discoveryConfig, cli.files);
		const { runtimeFiles, typeTestFiles } = classifyTestFiles(discovery.files, rootConfig);

		// Use stripped testMatch (no extensions) for Luau-side Jest execution
		const projConfig: ResolvedConfig = {
			...discoveryConfig,
			testMatch: project.testMatch,
		};

		allTypeTestFiles.push(...typeTestFiles);

		if (runtimeFiles.length === 0 && typeTestFiles.length === 0) {
			continue;
		}

		if (runtimeFiles.length > 0) {
			const result = await execute({
				backend,
				config: projConfig,
				deferFormatting: true,
				testFiles: runtimeFiles,
				version: VERSION,
			});
			projectResults.push({
				displayColor: project.displayColor,
				displayName: project.displayName,
				result,
			});
		}
	}

	const uniqueTypeTestFiles = [...new Set(allTypeTestFiles)];
	const typecheckResult =
		uniqueTypeTestFiles.length > 0
			? runTypecheck({
					files: uniqueTypeTestFiles,
					rootDir: rootConfig.rootDir,
					tsconfig: rootConfig.typecheckTsconfig,
				})
			: undefined;

	if (projectResults.length === 0 && typecheckResult === undefined) {
		console.error("No test files found in any project");
		return 2;
	}

	// Typecheck-only (no runtime results) — use single-project output path
	if (projectResults.length === 0) {
		return outputResults(rootConfig, typecheckResult, undefined, preCoverageMs);
	}

	return outputMultiProjectResults(rootConfig, projectResults, typecheckResult, preCoverageMs);
}

async function executeRuntimeTests(
	config: ResolvedConfig,
	testFiles: Array<string>,
	totalFiles: number,
): Promise<ExecuteResult> {
	const useDefaultFormatter =
		!config.silent && !usesAgentFormatter(config) && !hasFormatter(config, "json");
	if (useDefaultFormatter && testFiles.length !== totalFiles) {
		process.stderr.write(
			`Running ${String(testFiles.length)} of ${String(totalFiles)} test files\n`,
		);
	}

	const backend = await resolveBackend(config);

	return execute({
		backend,
		config,
		deferFormatting: true,
		testFiles,
		version: VERSION,
	});
}

function resolveSetupFilePaths(config: ResolvedConfig): void {
	if (config.setupFiles === undefined && config.setupFilesAfterEnv === undefined) {
		return;
	}

	const rojoConfigPath = path.resolve(config.rootDir, config.rojoProject ?? DEFAULT_ROJO_PROJECT);
	const resolve = createSetupResolver({
		configDirectory: config.rootDir,
		rojoConfigPath,
	});

	applySetupResolver(config, resolve);
}

async function runSingleProject(
	config: ResolvedConfig,
	cliFiles: Array<string> | undefined,
): Promise<number> {
	resolveSetupFilePaths(config);
	const discovery = discoverTestFiles(config, cliFiles);

	if (discovery.files.length === 0) {
		console.error("No test files found");
		return 2;
	}

	const typeTestFiles = config.typecheck
		? discovery.files.filter((file) => TYPE_TEST_PATTERN.test(file))
		: [];
	const runtimeTestFiles = config.typecheckOnly
		? []
		: discovery.files.filter((file) => !TYPE_TEST_PATTERN.test(file));

	if (typeTestFiles.length === 0 && runtimeTestFiles.length === 0) {
		console.error("No test files found for the selected mode");
		return 2;
	}

	// Coverage preparation: instrument, rewrite rojo project, build
	let preCoverageMs = 0;
	let effectiveConfig = config;
	if (config.collectCoverage && !config.typecheckOnly && runtimeTestFiles.length > 0) {
		const preCoverageStart = Date.now();
		const { placeFile } = prepareCoverage(config);
		preCoverageMs = Date.now() - preCoverageStart;
		effectiveConfig = { ...config, placeFile };
	}

	const typecheckResult =
		typeTestFiles.length > 0
			? runTypecheck({
					files: typeTestFiles,
					rootDir: effectiveConfig.rootDir,
					tsconfig: effectiveConfig.typecheckTsconfig,
				})
			: undefined;

	const runtimeResult =
		runtimeTestFiles.length > 0
			? await executeRuntimeTests(effectiveConfig, runtimeTestFiles, discovery.totalFiles)
			: undefined;

	return outputResults(effectiveConfig, typecheckResult, runtimeResult, preCoverageMs);
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

	const loadedConfig = await loadConfig(cli.config);
	const config = mergeCliWithConfig(cli, loadedConfig);

	// Check for project entries (Array<ProjectEntry>) on the resolved config
	const rawProjects = (config as unknown as { projects?: Array<ProjectEntry> }).projects;
	if (rawProjects !== undefined && rawProjects.length > 0) {
		return runMultiProject(cli, config, rawProjects);
	}

	return runSingleProject(config, cli.files);
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
		'Set "projects" in jest.config.ts (e.g. ["ReplicatedStorage/client", "ServerScriptService/server"]) or pass --projects.',
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

interface TestFileDiscovery {
	files: Array<string>;
	totalFiles: number;
}

function discoverTestFiles(config: ResolvedConfig, cliFiles?: Array<string>): TestFileDiscovery {
	if (cliFiles && cliFiles.length > 0) {
		const files = cliFiles.map((file) => path.resolve(config.rootDir, file));
		return { files, totalFiles: files.length };
	}

	const allFiles: Array<string> = [];
	for (const pattern of config.testMatch) {
		const matches = globSync(pattern, { cwd: config.rootDir });
		allFiles.push(...matches);
	}

	const ignoredPatterns = config.testPathIgnorePatterns.map((pat) => new RegExp(pat));

	const baseFiles = allFiles.filter((file) => {
		return !ignoredPatterns.some((pattern) => pattern.test(file));
	});

	const totalFiles = new Set(baseFiles).size;

	let filtered: Array<string> = baseFiles;
	if (config.testPathPattern !== undefined) {
		const pathPattern = new RegExp(config.testPathPattern);
		filtered = filtered.filter((file) => pathPattern.test(file));
	}

	return { files: [...new Set(filtered)], totalFiles };
}

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

function normalizeFormatterName(name: string): string {
	return name === "compact" ? "agent" : name;
}

function normalizeFormatterEntry(entry: FormatterEntry): FormatterEntry {
	if (Array.isArray(entry)) {
		return [normalizeFormatterName(entry[0]), entry[1]];
	}

	return normalizeFormatterName(entry);
}

function resolveFormatters(cli: CliOptions, config: ResolvedConfig): Array<FormatterEntry> {
	const explicit = cli.formatters ?? config.formatters;
	if (explicit !== undefined) {
		return explicit.map(normalizeFormatterEntry);
	}

	const defaults: Array<FormatterEntry> = isAgent ? ["agent"] : ["default"];

	if (process.env["GITHUB_ACTIONS"] === "true") {
		defaults.push("github-actions");
	}

	return defaults;
}

function mergeCliWithConfig(cli: CliOptions, config: ResolvedConfig): ResolvedConfig {
	return {
		...config,
		backend: cli.backend ?? config.backend,
		cache: cli.cache ?? config.cache,
		collectCoverage: cli.collectCoverage ?? config.collectCoverage,
		color: cli.color ?? config.color,
		coverageDirectory: cli.coverageDirectory ?? config.coverageDirectory,
		coverageReporters: cli.coverageReporters ?? config.coverageReporters,
		formatters: resolveFormatters(cli, config),
		gameOutput: cli.gameOutput ?? config.gameOutput,
		outputFile: cli.outputFile ?? config.outputFile,
		pollInterval: cli.pollInterval ?? config.pollInterval,
		port: cli.port ?? config.port,
		rojoProject: cli.rojoProject ?? config.rojoProject,
		setupFiles: cli.setupFiles ?? config.setupFiles,
		setupFilesAfterEnv: cli.setupFilesAfterEnv ?? config.setupFilesAfterEnv,
		showLuau: cli.showLuau ?? config.showLuau,
		silent: cli.silent ?? config.silent,
		sourceMap: cli.sourceMap ?? config.sourceMap,
		testNamePattern: cli.testNamePattern ?? config.testNamePattern,
		testPathPattern: cli.testPathPattern ?? config.testPathPattern,
		timeout: cli.timeout ?? config.timeout,
		typecheck: cli.typecheck ?? config.typecheck,
		typecheckOnly: cli.typecheckOnly ?? config.typecheckOnly,
		typecheckTsconfig: cli.typecheckTsconfig ?? config.typecheckTsconfig,
		updateSnapshot: cli.updateSnapshot ?? config.updateSnapshot,
		verbose: cli.verbose ?? config.verbose,
	};
}

function mergeResults(
	typecheck: JestResult | undefined,
	runtime: JestResult | undefined,
): JestResult {
	if (typecheck !== undefined && runtime !== undefined) {
		return {
			numFailedTests: typecheck.numFailedTests + runtime.numFailedTests,
			numPassedTests: typecheck.numPassedTests + runtime.numPassedTests,
			numPendingTests: typecheck.numPendingTests + runtime.numPendingTests,
			numTodoTests: (typecheck.numTodoTests ?? 0) + (runtime.numTodoTests ?? 0),
			numTotalTests: typecheck.numTotalTests + runtime.numTotalTests,
			startTime: Math.min(typecheck.startTime, runtime.startTime),
			success: typecheck.success && runtime.success,
			testResults: [...typecheck.testResults, ...runtime.testResults],
		};
	}

	const result = typecheck ?? runtime;
	assert(result !== undefined, "mergeResults requires at least one result");
	return result;
}
