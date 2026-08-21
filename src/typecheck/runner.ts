import { type } from "arktype";
import { parseJSONC } from "confbox";
import { type ChildProcess, execFile, type ExecFileException } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import process from "node:process";

import { ConfigError } from "../config/errors.ts";
import type { JestResult, TestCaseResult, TestFileResult } from "../types/jest-result.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { collectTestDefinitions } from "./collect.ts";
import { parseTscOutput } from "./parse.ts";
import type { RawErrorsMap, TestDefinition, TscErrorInfo } from "./types.ts";

/**
 * Milliseconds to wait for tsgo to launch (the child `spawn` event) before the
 * pass fails. Bounds only process startup, so a slow *compile* never trips it;
 * the compile itself is governed by {@link TypecheckOptions.timeout}.
 */
const DEFAULT_SPAWN_TIMEOUT = 10_000;

/**
 * Milliseconds the tsgo compile may run before it is killed and the pass
 * throws. Mirrors the run-level `timeout` default (`config.timeout`); callers
 * pass the resolved run timeout so a wedged compile dies on the same deadline
 * as the Roblox run instead of a tight typecheck-only number.
 */
const DEFAULT_RUN_TIMEOUT = 300_000;

const MISSING_TSGO_MESSAGE =
	"Type tests need '@typescript/native-preview', an optional peer " +
	"dependency that is not installed.";

const MISSING_TSGO_HINT =
	"npm install -D @typescript/native-preview — or run without --typecheck/--typecheckOnly.";

const compositeTsconfigSchema = type({
	"compilerOptions?": {
		"composite?": "boolean",
	},
});

export interface TypecheckOptions {
	files: Array<string>;
	/**
	 * When `false` (default), tsgo errors in non-test source files surface as
	 * source-level failures. When `true`, only errors inside the discovered
	 * Type Test files are reported.
	 */
	ignoreSourceErrors?: boolean | undefined;
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

interface FileInfo {
	definitions: Array<TestDefinition>;
	source: string;
}

/** tsc errors split by whether they fall inside a discovered Type Test. */
interface PartitionedErrors {
	errorsByTest: Map<string, Array<string>>;
	fileErrors: Array<string>;
}

interface ExecuteTsgoOptions {
	args: Array<string>;
	cwd: string;
	reject: (reason: Error) => void;
	resolve: (value: string) => void;
	runTimeout: number;
	spawnTimeout: number;
	tsgoScript: string;
}

interface SettleTsgoOptions {
	error: ExecFileException | null;
	finish: (action: () => void) => void;
	reject: (reason: Error) => void;
	resolve: (value: string) => void;
	runTimeout: number;
	stderr: string;
	stdout: string;
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

export function mapErrorsToTests(
	errors: RawErrorsMap,
	files: Map<string, FileInfo>,
	startTime: number,
	ignoreSourceErrors = false,
): JestResult {
	const testResults: Array<TestFileResult> = [];
	let numberFailed = 0;
	let numberPassed = 0;

	for (const [filePath, fileInfo] of files) {
		const fileErrors = errors.get(filePath) ?? [];
		const fileResult = buildFileResult(filePath, fileInfo, fileErrors);
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

export function isCompositeProject(rootDirectory: string, tsconfig?: string): boolean {
	const tsconfigPath =
		tsconfig !== undefined
			? path.resolve(rootDirectory, tsconfig)
			: path.join(rootDirectory, "tsconfig.json");

	try {
		const raw = compositeTsconfigSchema.assert(
			parseJSONC(fs.readFileSync(tsconfigPath, "utf-8")),
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

// cspell:ignore tsgo
export async function runTypecheckAsync(options: TypecheckOptions): Promise<JestResult> {
	const startTime = Date.now();
	const tsgoOutput = await spawnTsgoAsync(options);
	const errors = parseTscOutput(tsgoOutput);

	const files = new Map<string, FileInfo>();
	for (const filePath of options.files) {
		const source = fs.readFileSync(filePath, "utf-8");
		const definitions = collectTestDefinitions(source);
		const resolvedPath = path.resolve(filePath);
		const key = normalizeWindowsPath(path.relative(options.rootDir, resolvedPath));
		files.set(key, { definitions, source });
	}

	const resolvedErrors: RawErrorsMap = new Map();
	for (const [errorPath, errorList] of errors) {
		const resolved = path.resolve(options.rootDir, errorPath);
		const key = normalizeWindowsPath(path.relative(options.rootDir, resolved));
		resolvedErrors.set(key, errorList);
	}

	return mapErrorsToTests(resolvedErrors, files, startTime, options.ignoreSourceErrors);
}

function buildSourceResult(filePath: string, errors: Array<TscErrorInfo>): TestFileResult {
	const failureMessages = errors.map(
		(error) => `TS${String(error.errorCode)}: ${error.errorMessage}`,
	);

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
function partitionErrors(
	errors: Array<TscErrorInfo>,
	indexMap: Map<string, number>,
	sortedDefinitions: Array<TestDefinition>,
): PartitionedErrors {
	const errorsByTest = new Map<string, Array<string>>();
	const fileErrors: Array<string> = [];

	for (const error of errors) {
		const charIndex = indexMap.get(`${String(error.line)}:${String(error.column)}`);
		const definition =
			charIndex !== undefined
				? sortedDefinitions.find((td) => td.start <= charIndex && td.end >= charIndex)
				: undefined;

		const message = `TS${String(error.errorCode)}: ${error.errorMessage}`;

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

function buildFileResult(
	filePath: string,
	fileInfo: FileInfo,
	errors: Array<TscErrorInfo>,
): TestFileResult {
	const indexMap = createLocationsIndexMap(fileInfo.source);
	const testDefinitions = fileInfo.definitions.filter((definition) => definition.type === "test");
	const sortedDefinitions = testDefinitions.toSorted((a, b) => b.start - a.start);

	const partitioned = partitionErrors(errors, indexMap, sortedDefinitions);
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

// tsgo is an optional peer dependency, so its absence is an ordinary state to
// report rather than a broken install — `require.resolve` only raises a bare
// `MODULE_NOT_FOUND`, which reads as a fault inside the CLI. `ConfigError`
// matches the sibling guard that rejects `--typecheck` under the standalone
// binary, and puts the install command in the banner's `Hint:` slot.
function resolveTsgoScript(): string {
	const require = createRequire(import.meta.url);

	let packageJsonPath: string;
	try {
		packageJsonPath = require.resolve("@typescript/native-preview/package.json");
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "MODULE_NOT_FOUND") {
			throw new ConfigError(MISSING_TSGO_MESSAGE, MISSING_TSGO_HINT);
		}

		throw err;
	}

	return path.join(path.dirname(packageJsonPath), "bin", "tsgo.js");
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

// Classifies the `execFile` outcome onto the promise. Split out of the callback
// so neither this nor `executeTsgo` carries the whole spawn lifecycle.
function settleTsgoResult({
	error,
	finish,
	reject,
	resolve,
	runTimeout,
	stderr,
	stdout,
}: SettleTsgoOptions): void {
	if (error === null) {
		finish(() => {
			resolve(stdout);
		});
		return;
	}

	// `execFile`'s `timeout` (the run-level deadline) is the only kill it
	// causes, so `killed` is timeout-specific here: maxBuffer overflow surfaces
	// as a distinct `code` (ERR_CHILD_PROCESS_STDIO_MAXBUFFER) with `killed`
	// unset. (The launch-timer kill settles the promise first, so its later
	// `killed` callback is a no-op.) Fail loud rather than let truncated/empty
	// output read as zero type errors.
	if (error.killed === true) {
		const message = `tsgo typecheck timed out after ${String(runTimeout)}ms (timeout)`;
		finish(() => {
			reject(new Error(message));
		});
		return;
	}

	// tsgo exits non-zero (numeric `code`) when diagnostics exist; the captured
	// output carries them. A non-numeric code means the process never ran (e.g.
	// ENOENT) — rethrow so a real spawn failure isn't masked as a clean pass.
	if (typeof error.code === "number") {
		finish(() => {
			resolve(stdout !== "" ? stdout : stderr);
		});
		return;
	}

	finish(() => {
		reject(new Error(error.message, { cause: error }));
	});
}

// Kills the child if it never reports a `spawn` event, then rejects.
function armLaunchTimer({
	child,
	finish,
	reject,
	spawnTimeout,
}: {
	child: ChildProcess;
	finish: (action: () => void) => void;
	reject: (reason: Error) => void;
	spawnTimeout: number;
}): ReturnType<typeof setTimeout> {
	const message = `tsgo spawn timed out after ${String(spawnTimeout)}ms (spawnTimeout)`;
	return setTimeout(() => {
		child.kill();
		finish(() => {
			reject(new Error(message));
		});
	}, spawnTimeout);
}

// Launches tsgo and wires both settle paths (the `execFile` callback and the
// launch timer) into the caller's promise.
function executeTsgo({
	args,
	cwd,
	reject,
	resolve,
	runTimeout,
	spawnTimeout,
	tsgoScript,
}: ExecuteTsgoOptions): void {
	let launchTimer: ReturnType<typeof setTimeout> | undefined;
	// `finish` settles the promise exactly once, guarding the two kill sources
	// (launch timer + `execFile` run-timeout) from racing. A holder object, not
	// a bare `let settled = false`: typescript-eslint's
	// `no-unnecessary-condition` narrows a bare boolean to literal `false` at
	// the `!state.settled` arming guard below (the closure that flips it has not
	// run there) and flags it as always-true; an object property infers as
	// `boolean`.
	const state = { settled: false };

	function finish(action: () => void): void {
		if (state.settled) {
			return;
		}

		state.settled = true;
		if (launchTimer !== undefined) {
			clearTimeout(launchTimer);
		}

		action();
	}

	const child = execFile(
		process.execPath,
		[tsgoScript, ...args],
		{ cwd, encoding: "utf-8", timeout: runTimeout, windowsHide: true },
		(error, stdout, stderr) => {
			settleTsgoResult({ error, finish, reject, resolve, runTimeout, stderr, stdout });
		},
	);

	// Bound only the launch: cleared the instant tsgo reports it spawned, so a
	// slow compile is governed by `runTimeout` above, not this. `spawn` fires at
	// most once, so `once` is the right primitive. Arming is skipped below when
	// the (synchronous-in-test) callback already settled.
	child.once("spawn", () => {
		clearTimeout(launchTimer);
	});

	if (!state.settled) {
		launchTimer = armLaunchTimer({ child, finish, reject, spawnTimeout });
	}
}

// Async so the CPU-bound tsgo subprocess overlaps the network-bound Roblox run
// (the host event loop stays free to drive the Open Cloud upload/poll while
// tsgo compiles). Two distinct guards keep the awaited pass from hanging: a
// launch timer (`spawnTimeout`, cleared on the child `spawn` event) bounds
// startup, and `execFile`'s own `timeout` (`options.timeout`, the run-level
// deadline) bounds the compile.
async function spawnTsgoAsync(options: TypecheckOptions): Promise<string> {
	const isComposite = isCompositeProject(options.rootDir, options.tsconfig);
	const args = buildTsgoArgs(options, isComposite);
	const tsgoScript = resolveTsgoScript();
	const spawnTimeout = options.spawnTimeout ?? DEFAULT_SPAWN_TIMEOUT;
	const runTimeout = options.timeout ?? DEFAULT_RUN_TIMEOUT;

	return new Promise<string>((resolve, reject) => {
		executeTsgo({
			args,
			cwd: options.rootDir,
			reject,
			resolve,
			runTimeout,
			spawnTimeout,
			tsgoScript,
		});
	});
}
