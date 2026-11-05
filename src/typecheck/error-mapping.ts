import type { JestResult, TestCaseResult, TestFileResult } from "../types/jest-result-types.ts";
import type { RawErrorsMap, TestDefinition, TypeTestDiagnostic } from "./typecheck-types.ts";

/** The definitions and position index of one type-test file. */
export interface FileInfo {
	/** The file's suites and tests. */
	definitions: Array<TestDefinition>;
	/** Source offset of each `line:column` position. */
	locations: Map<string, number>;
}

/** Errors from tsc, split by whether they fall in a discovered Type Test. */
interface PartitionedErrors {
	errorsByTest: Map<string, Array<string>>;
	fileErrors: Array<string>;
}
/**
 * Turn type-checker errors into a Jest result, one case per Type Test.
 * @param options - The errors, the files they belong to and the start time.
 * @param options.errors - The diagnostics by file path.
 * @param options.files - The type-test files and their definitions.
 * @param options.ignoreSourceErrors - Drop errors in non-test files.
 * @param options.startTime - The run's start, as epoch milliseconds.
 * @returns The aggregated Jest result.
 */
export function mapErrorsToTests({
	errors,
	files,
	ignoreSourceErrors = false,
	startTime,
}: {
	/** The diagnostics by file path. */
	errors: RawErrorsMap;
	/** The type-test files and their definitions. */
	files: Map<string, FileInfo>;
	/** Drop errors in non-test files. */
	ignoreSourceErrors?: boolean | undefined;
	/** The run's start, as epoch milliseconds. */
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

/**
 * Index every `line:column` position of a source, counted in code points.
 * @param source - The source text.
 * @returns The code-point index of each 1-indexed `line:column` key.
 */
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

/**
 * Errors reported against files that are not Type Test files become one
 * source-level failure each. The caller decides whether to include them
 * (`ignoreSourceErrors`).
 * @param errors - The diagnostics by file path.
 * @param files - The type-test files, which are skipped.
 * @returns One failed file result per non-test file with errors.
 */
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

/**
 * Each tsc error lands either inside a `test(...)` body (attributed to that
 * test) or outside every one of them (a file-level failure). `sortedDefinitions`
 * is descending by `start`, so the first containing definition found is the
 * innermost.
 * @param options - The file's errors, position index and definitions.
 * @param options.errors - The file's diagnostics.
 * @param options.indexMap - Source offset of each `line:column` position.
 * @param options.sortedDefinitions - Definitions, descending by `start`.
 * @returns Error messages by test name, and the file-level ones.
 */
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

/**
 * One case per discovered Type Test, plus a synthetic leading case carrying the
 * file-level errors when there are any.
 * @param testDefinitions - The file's tests.
 * @param partitioned - The file's errors, split by test.
 * @param partitioned.errorsByTest - Error messages by test name.
 * @param partitioned.fileErrors - Errors outside every test.
 * @returns The file's test cases.
 */
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
