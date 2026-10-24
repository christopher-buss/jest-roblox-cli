import { type } from "arktype";
import { parseJSONC } from "confbox";
import { createRequire } from "node:module";
import * as path from "node:path";
import process from "node:process";

import { ConfigError } from "../config/errors.ts";
import type { JestResult, TestCaseResult, TestFileResult } from "../types/jest-result.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { nodeChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { collectTestDefinitions } from "./collect.ts";
import { spawnLuauCheckAsync } from "./luau-check.ts";
import { collectLuauTestDefinitions, createByteLocationsIndexMap } from "./luau-collect.ts";
import { applyLuauExpectErrors } from "./luau-expect-error.ts";
import { parseLuauOutput } from "./luau-parse.ts";
import { parseTscOutput } from "./parse.ts";
import { DEFAULT_RUN_TIMEOUT, DEFAULT_SPAWN_TIMEOUT, spawnCheckerAsync } from "./spawn-checker.ts";
import { LUAU_TYPE_TEST_PATTERN, TS_TYPE_TEST_PATTERN } from "./type-test-pattern.ts";
import type { CollectedFile, RawErrorsMap, TestDefinition, TypeTestDiagnostic } from "./types.ts";

const MISSING_TSGO_MESSAGE =
	"Type tests need TypeScript 7 ('typescript' 7+, or '@typescript/native' " +
	"beside TypeScript 6), an optional peer dependency that is not installed.";

const MISSING_TSGO_HINT =
	"npm install -D typescript@7 — or run without --typecheck/--typecheckOnly.";

// TypeScript's advice for running 7 beside 6 aliases 7 as `@typescript/native`;
// `@typescript/native-preview` is the nightly package 7 replaced.
const TSGO_PACKAGES = [
	{ name: "@typescript/native", bin: "tsc" },
	{ name: "typescript", bin: "tsc" },
	{ name: "@typescript/native-preview", bin: "tsgo" },
] as const;

// The manifest's `bin` field is the only stable name for the compiler script.
const tsgoManifestSchema = type({
	"bin?": { "[string]": "string > 0" },
	"version": "string",
});

const compositeTsconfigSchema = type({
	"compilerOptions?": {
		"composite?": "boolean",
	},
});

export interface TypecheckOptions {
	/** What launches tsgo. Defaults to the real launcher. */
	childProcess?: ChildProcessRunner;
	files: Array<string>;
	/**
	 * Where the type-test sources are read. Defaults to the real filesystem.
	 */
	fileSystem?: FileSystem;
	/**
	 * When `false` (default), tsgo errors in non-test source files surface as
	 * source-level failures. When `true`, only errors inside the discovered
	 * Type Test files are reported.
	 */
	ignoreSourceErrors?: boolean | undefined;
	/**
	 * How a package specifier becomes a path. Defaults to CJS resolution off
	 * this module, which is the only thing that reads `node:module` here.
	 */
	resolveModule?: (specifier: string) => string;
	rootDir: string;
	/**
	 * Milliseconds to wait for the tsgo process to launch before the pass
	 * throws. The timer is cleared the instant tsgo reports it spawned; it does
	 * not bound the compile. Defaults to {@link DEFAULT_SPAWN_TIMEOUT}.
	 */
	spawnTimeout?: number | undefined;
	/**
	 * Milliseconds the tsgo *compile* may run before it is killed and the pass
	 * throws. The run-level `timeout`. Defaults to {@link DEFAULT_RUN_TIMEOUT}.
	 */
	timeout?: number | undefined;
	tsconfig?: string | undefined;
}

// cspell:ignore tsgo
export type RunTypecheck = typeof runTypecheckAsync;

interface FileInfo {
	definitions: Array<TestDefinition>;
	locations: Map<string, number>;
}

/** tsc errors split by whether they fall inside a discovered Type Test. */
interface PartitionedErrors {
	errorsByTest: Map<string, Array<string>>;
	fileErrors: Array<string>;
}

type CheckerSpawnOptions = TypecheckOptions & { childProcess: ChildProcessRunner };

interface TypeChecker {
	collect: (source: string) => CollectedFile;
	filter: typeof applyLuauExpectErrors;
	locate: (source: string) => Map<string, number>;
	parse: (output: string) => RawErrorsMap;
	pattern: RegExp;
	spawn: (options: CheckerSpawnOptions) => Promise<string>;
}

interface CheckerRun {
	checker: TypeChecker;
	checkerFiles: Array<string>;
	output: string;
}

export function mapErrorsToTests({
	errors,
	files,
	ignoreSourceErrors = false,
	startTime,
}: {
	errors: RawErrorsMap;
	files: Map<string, FileInfo>;
	ignoreSourceErrors?: boolean | undefined;
	startTime: number;
}): JestResult {
	const testResults: Array<TestFileResult> = [];
	let numberFailed = 0;
	let numberPassed = 0;

	for (const [filePath, fileInfo] of files) {
		const fileErrors = errors.get(filePath) ?? [];
		const fileResult = buildFileResult({ errors: fileErrors, fileInfo, filePath });
		testResults.push(fileResult);
		numberFailed += fileResult.numFailingTests;
		numberPassed += fileResult.numPassingTests;
	}

	if (!ignoreSourceErrors) {
		for (const sourceResult of collectSourceResults(errors, files)) {
			testResults.push(sourceResult);
			numberFailed += sourceResult.numFailingTests;
		}
	}

	return {
		numFailedTests: numberFailed,
		numPassedTests: numberPassed,
		numPendingTests: 0,
		numTotalTests: numberFailed + numberPassed,
		startTime,
		success: numberFailed === 0,
		testResults,
	};
}

export async function runTypecheckAsync(options: TypecheckOptions): Promise<JestResult> {
	const { fileSystem = nodeFileSystem } = options;
	const startTime = Date.now();

	const outputs = await runCheckersAsync(options);

	const files = new Map<string, FileInfo>();
	const resolvedErrors: RawErrorsMap = new Map();
	for (const run of outputs) {
		appendErrors(resolvedErrors, collectCheckerRun({ files, fileSystem, options, run }));
	}

	return mapErrorsToTests({
		errors: resolvedErrors,
		files,
		ignoreSourceErrors: options.ignoreSourceErrors,
		startTime,
	});
}

export function createLocationsIndexMap(source: string): Map<string, number> {
	const map = new Map<string, number>();
	let index = 0;
	let line = 1;
	let column = 1;

	for (const char of source) {
		map.set(`${String(line)}:${String(column)}`, index);
		index++;

		if (char === "\n") {
			line++;
			column = 1;
		} else {
			column++;
		}
	}

	return map;
}

export function isCompositeProject({
	fileSystem = nodeFileSystem,
	rootDirectory,
	tsconfig,
}: {
	fileSystem?: FileSystem;
	rootDirectory: string;
	tsconfig?: string | undefined;
}): boolean {
	const tsconfigPath =
		tsconfig !== undefined
			? path.resolve(rootDirectory, tsconfig)
			: path.join(rootDirectory, "tsconfig.json");

	try {
		const raw = compositeTsconfigSchema.assert(
			parseJSONC(fileSystem.readFileSync(tsconfigPath, "utf-8")),
		);
		return raw.compilerOptions?.composite === true;
	} catch (err) {
		if (tsconfig !== undefined) {
			const message = err instanceof Error ? err.message : String(err);
			process.stderr.write(
				`Warning: could not read tsconfig "${tsconfigPath}": ${message}\n`,
			);
		}

		return false;
	}
}

function buildSourceResult(filePath: string, errors: Array<TypeTestDiagnostic>): TestFileResult {
	const failureMessages = errors.map((error) => `${error.code}: ${error.message}`);

	return {
		numFailingTests: 1,
		numPassingTests: 0,
		numPendingTests: 0,
		testFilePath: filePath,
		testResults: [
			{
				ancestorTitles: [],
				failureMessages,
				fullName: "<source type error>",
				status: "failed",
				title: "<source type error>",
			},
		],
	};
}

// Errors reported against files that are not Type Test files become one
// source-level failure each. The caller decides whether to include them
// (`ignoreSourceErrors`).
function collectSourceResults(
	errors: RawErrorsMap,
	files: Map<string, FileInfo>,
): Array<TestFileResult> {
	const sourceResults: Array<TestFileResult> = [];
	for (const [filePath, fileErrors] of errors) {
		if (files.has(filePath)) {
			continue;
		}

		sourceResults.push(buildSourceResult(filePath, fileErrors));
	}

	return sourceResults;
}

// Each tsc error lands either inside a `test(...)` body (attributed to that
// test) or outside every one of them (a file-level failure). `sortedDefinitions`
// is descending by `start`, so the first containing definition found is the
// innermost.
function partitionErrors({
	errors,
	indexMap,
	sortedDefinitions,
}: {
	errors: Array<TypeTestDiagnostic>;
	indexMap: Map<string, number>;
	sortedDefinitions: Array<TestDefinition>;
}): PartitionedErrors {
	const errorsByTest = new Map<string, Array<string>>();
	const fileErrors: Array<string> = [];

	for (const error of errors) {
		const charIndex = indexMap.get(`${String(error.line)}:${String(error.column)}`);
		const definition =
			charIndex !== undefined
				? sortedDefinitions.find((td) => td.start <= charIndex && td.end >= charIndex)
				: undefined;

		const message = `${error.code}: ${error.message}`;

		if (definition) {
			const existing = errorsByTest.get(definition.name) ?? [];
			existing.push(message);
			errorsByTest.set(definition.name, existing);
		} else {
			fileErrors.push(message);
		}
	}

	return { errorsByTest, fileErrors };
}

// One case per discovered Type Test, plus a synthetic leading case carrying the
// file-level errors when there are any.
function buildTestCases(
	testDefinitions: Array<TestDefinition>,
	{ errorsByTest, fileErrors }: PartitionedErrors,
): Array<TestCaseResult> {
	const testCases: Array<TestCaseResult> = testDefinitions.map((definition) => {
		const failures = errorsByTest.get(definition.name) ?? [];
		return {
			ancestorTitles: definition.ancestorNames,
			failureMessages: failures,
			fullName: [...definition.ancestorNames, definition.name].join(" > "),
			status: failures.length > 0 ? "failed" : "passed",
			title: definition.name,
		};
	});

	if (fileErrors.length > 0) {
		testCases.unshift({
			ancestorTitles: [],
			failureMessages: fileErrors,
			fullName: "<file-level type error>",
			status: "failed",
			title: "<file-level type error>",
		});
	}

	return testCases;
}

function buildFileResult({
	errors,
	fileInfo,
	filePath,
}: {
	errors: Array<TypeTestDiagnostic>;
	fileInfo: FileInfo;
	filePath: string;
}): TestFileResult {
	const testDefinitions = fileInfo.definitions.filter((definition) => definition.type === "test");
	const sortedDefinitions = testDefinitions.toSorted((a, b) => b.start - a.start);

	const partitioned = partitionErrors({
		errors,
		indexMap: fileInfo.locations,
		sortedDefinitions,
	});
	const testCases = buildTestCases(testDefinitions, partitioned);
	const numberFailing = testCases.filter((testCase) => testCase.status === "failed").length;

	return {
		numFailingTests: numberFailing,
		numPassingTests: testCases.length - numberFailing,
		numPendingTests: 0,
		testFilePath: filePath,
		testResults: testCases,
	};
}

function appendErrors(errors: RawErrorsMap, additions: RawErrorsMap): void {
	for (const [key, errorList] of additions) {
		errors.set(key, [...(errors.get(key) ?? []), ...errorList]);
	}
}

function relativeKey(rootDirectory: string, filePath: string): string {
	return normalizeWindowsPath(
		path.relative(rootDirectory, path.resolve(rootDirectory, filePath)),
	);
}

function resolveFileErrors({
	checker,
	problems,
	...file
}: Parameters<TypeChecker["filter"]>[0] & {
	checker: TypeChecker;
	problems: CollectedFile["problems"];
}): Array<TypeTestDiagnostic> {
	if (problems.length === 0) {
		return checker.filter(file);
	}

	return problems.map((problem) => {
		return { ...problem, column: 0, filePath: file.filePath, line: 0 };
	});
}

function collectCheckerRun({
	files,
	fileSystem,
	options,
	run: { checker, checkerFiles, output },
}: {
	files: Map<string, FileInfo>;
	fileSystem: FileSystem;
	options: TypecheckOptions;
	run: CheckerRun;
}): RawErrorsMap {
	const checkerErrors: RawErrorsMap = new Map();
	for (const [errorPath, errorList] of checker.parse(output)) {
		appendErrors(
			checkerErrors,
			new Map([[relativeKey(options.rootDir, errorPath), errorList]]),
		);
	}

	for (const filePath of checkerFiles) {
		const source = fileSystem.readFileSync(filePath, "utf-8");
		const { definitions, problems } = checker.collect(source);
		const key = normalizeWindowsPath(path.relative(options.rootDir, path.resolve(filePath)));
		files.set(key, { definitions, locations: checker.locate(source) });
		const diagnostics = resolveFileErrors({
			checker,
			diagnostics: checkerErrors.get(key) ?? [],
			filePath: key,
			problems,
			source,
		});
		if (diagnostics.length > 0) {
			checkerErrors.set(key, diagnostics);
		} else {
			checkerErrors.delete(key);
		}
	}

	return checkerErrors;
}

function selectTypeChecker(filePath: string): TypeChecker {
	return TYPE_CHECKERS.find(({ pattern }) => pattern.test(filePath)) ?? FALLBACK_CHECKER;
}

async function runCheckersAsync(options: TypecheckOptions): Promise<Array<CheckerRun>> {
	const childProcess = options.childProcess ?? nodeChildProcessRunner;
	const filesByChecker: Map<TypeChecker, Array<string>> = options.files.length > 0
		? Map.groupBy(options.files, selectTypeChecker)
		: new Map([[FALLBACK_CHECKER, []]]);

	if (process.env["JEST_ROBLOX_SEA"] === "true" && filesByChecker.has(FALLBACK_CHECKER)) {
		throw new ConfigError(
			"--typecheck is not available in the standalone binary. Install via npm instead.",
		);
	}

	return Promise.all(
		Array.from(filesByChecker, async ([checker, checkerFiles]) => {
			return {
				checker,
				checkerFiles,
				output: await checker.spawn({ ...options, childProcess, files: checkerFiles }),
			};
		}),
	);
}

/** CJS resolution off this module — the only thing here that needs it. */
function defaultResolveModule(specifier: string): string {
	return createRequire(import.meta.url).resolve(specifier);
}

// TypeScript 7 is an optional peer dependency, so its absence is an ordinary
// state to report rather than a broken install — `require.resolve` only raises
// a bare `MODULE_NOT_FOUND`, which reads as a fault inside the CLI. `ConfigError`
// matches the sibling guard that rejects `--typecheck` under the standalone
// binary, and puts the install command in the banner's `Hint:` slot.
function resolveManifest(
	resolveModule: (specifier: string) => string,
	packageName: string,
): string | undefined {
	try {
		return resolveModule(`${packageName}/package.json`);
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "MODULE_NOT_FOUND") {
			return undefined;
		}

		throw err;
	}
}

function resolveTsgoScript(
	resolveModule: (specifier: string) => string,
	fileSystem: FileSystem,
): string {
	for (const { name, bin: binName } of TSGO_PACKAGES) {
		const packageJsonPath = resolveManifest(resolveModule, name);
		if (packageJsonPath === undefined) {
			continue;
		}

		const { bin, version } = tsgoManifestSchema.assert(
			JSON.parse(fileSystem.readFileSync(packageJsonPath, "utf-8")),
		);
		const script = bin?.[binName];
		if (script !== undefined && Number.parseInt(version, 10) >= 7) {
			return path.join(path.dirname(packageJsonPath), script);
		}
	}

	throw new ConfigError(MISSING_TSGO_MESSAGE, MISSING_TSGO_HINT);
}

// A composite project must be driven through `--build` (and emit declarations
// so downstream references resolve); a plain one type-checks with `--noEmit`.
// The two also take the tsconfig differently: `--build` accepts it positionally,
// while a plain run needs `-p`.
function buildTsgoArgs(options: TypecheckOptions, isComposite: boolean): Array<string> {
	const args: Array<string> = [];

	if (isComposite) {
		args.push("--build", "--emitDeclarationOnly");
	} else {
		args.push("--noEmit");
	}

	args.push("--pretty", "false");

	if (options.tsconfig !== undefined) {
		const resolvedTsconfig = path.resolve(options.rootDir, options.tsconfig);
		if (isComposite) {
			args.push(resolvedTsconfig);
		} else {
			args.push("-p", resolvedTsconfig);
		}
	}

	return args;
}

// Async so the CPU-bound tsgo subprocess overlaps the network-bound Roblox run
// (the host event loop stays free to drive the Open Cloud upload/poll while
// tsgo compiles). Two distinct guards keep the awaited pass from hanging: a
// launch timer (`spawnTimeout`, cleared on the child `spawn` event) bounds
// startup, and `execFile`'s own `timeout` (`options.timeout`, the run-level
// deadline) bounds the compile.
async function spawnTsgoAsync(options: CheckerSpawnOptions): Promise<string> {
	const { childProcess, fileSystem = nodeFileSystem } = options;
	const isComposite = isCompositeProject({
		fileSystem,
		rootDirectory: options.rootDir,
		tsconfig: options.tsconfig,
	});
	const args = buildTsgoArgs(options, isComposite);
	const tsgoScript = resolveTsgoScript(options.resolveModule ?? defaultResolveModule, fileSystem);
	const spawnTimeout = options.spawnTimeout ?? DEFAULT_SPAWN_TIMEOUT;
	const runTimeout = options.timeout ?? DEFAULT_RUN_TIMEOUT;

	return spawnCheckerAsync({
		args: [tsgoScript, ...args],
		childProcess,
		command: process.execPath,
		cwd: options.rootDir,
		label: "tsgo",
		runTimeout,
		spawnTimeout,
	});
}

async function spawnLuauAsync(options: CheckerSpawnOptions): Promise<string> {
	return spawnLuauCheckAsync({
		childProcess: options.childProcess,
		files: options.files,
		rootDir: options.rootDir,
		runTimeout: options.timeout ?? DEFAULT_RUN_TIMEOUT,
		spawnTimeout: options.spawnTimeout ?? DEFAULT_SPAWN_TIMEOUT,
	});
}

const FALLBACK_CHECKER: TypeChecker = {
	collect: (source) => ({ definitions: collectTestDefinitions(source), problems: [] }),
	filter: ({ diagnostics }) => diagnostics,
	locate: createLocationsIndexMap,
	parse: parseTscOutput,
	pattern: TS_TYPE_TEST_PATTERN,
	spawn: spawnTsgoAsync,
};

const LUAU_CHECKER: TypeChecker = {
	collect: collectLuauTestDefinitions,
	filter: applyLuauExpectErrors,
	locate: createByteLocationsIndexMap,
	parse: parseLuauOutput,
	pattern: LUAU_TYPE_TEST_PATTERN,
	spawn: spawnLuauAsync,
};

const TYPE_CHECKERS: ReadonlyArray<TypeChecker> = [LUAU_CHECKER, FALLBACK_CHECKER];
