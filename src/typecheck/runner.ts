import { parseJSONC } from "confbox";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import process from "node:process";

import type { JestResult, TestCaseResult, TestFileResult } from "../types/jest-result.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { collectTestDefinitions } from "./collect.ts";
import { parseTscOutput } from "./parse.ts";
import type { RawErrorsMap, TestDefinition, TscErrorInfo } from "./types.ts";

export interface TypecheckOptions {
	files: Array<string>;
	rootDir: string;
	tsconfig?: string;
}

interface FileInfo {
	definitions: Array<TestDefinition>;
	source: string;
}

interface ExecSyncError {
	stderr?: string;
	stdout?: string;
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
		const raw = parseJSONC<Record<string, unknown>>(fs.readFileSync(tsconfigPath, "utf-8"));
		const compilerOptions = raw["compilerOptions"] as Record<string, unknown> | undefined;
		return compilerOptions?.["composite"] === true;
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
export function runTypecheck(options: TypecheckOptions): JestResult {
	const startTime = Date.now();
	const tsgoOutput = spawnTsgo(options);
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

	return mapErrorsToTests(resolvedErrors, files, startTime);
}

function buildFileResult(
	filePath: string,
	fileInfo: FileInfo,
	errors: Array<TscErrorInfo>,
): TestFileResult {
	const indexMap = createLocationsIndexMap(fileInfo.source);
	const testDefinitions = fileInfo.definitions.filter((definition) => definition.type === "test");
	const sortedDefinitions = [...testDefinitions].sort((a, b) => b.start - a.start);

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

	const numberFailing = testCases.filter((testCase) => testCase.status === "failed").length;

	return {
		numFailingTests: numberFailing,
		numPassingTests: testCases.length - numberFailing,
		numPendingTests: 0,
		testFilePath: filePath,
		testResults: testCases,
	};
}

function isExecSyncError(err: unknown): err is ExecSyncError {
	return typeof err === "object" && err !== null && ("stdout" in err || "stderr" in err);
}

function resolveTsgoScript(): string {
	const require = createRequire(import.meta.url);
	const packageJsonPath = require.resolve("@typescript/native-preview/package.json");
	return path.join(path.dirname(packageJsonPath), "bin", "tsgo.js");
}

function spawnTsgo(options: TypecheckOptions): string {
	const composite = isCompositeProject(options.rootDir, options.tsconfig);
	const args: Array<string> = [];

	if (composite) {
		args.push("--build", "--emitDeclarationOnly");
	} else {
		args.push("--noEmit");
	}

	args.push("--pretty", "false");

	if (options.tsconfig !== undefined) {
		const resolvedTsconfig = path.resolve(options.rootDir, options.tsconfig);
		if (composite) {
			args.push(resolvedTsconfig);
		} else {
			args.push("-p", resolvedTsconfig);
		}
	}

	const tsgoScript = resolveTsgoScript();

	try {
		return execFileSync(process.execPath, [tsgoScript, ...args], {
			cwd: options.rootDir,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err: unknown) {
		if (!isExecSyncError(err)) {
			throw err;
		}

		return err.stdout ?? err.stderr ?? "";
	}
}
