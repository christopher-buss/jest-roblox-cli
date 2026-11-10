import type { ExecErrorTestFileResult, TestFileResult } from "./jest-result-types.ts";

/** Synthetic path a suite that never ran is filed under. */
export const EXEC_ERROR_FILE_PATH = "<exec-error>";

/**
 * Describe a suite that never ran, in the wording every formatter uses.
 * @param file - The file result of a suite that never ran.
 * @returns `"timed out"` for a timeout, else `"failed to run"`.
 */
export function execErrorReason(file: TestFileResult): "failed to run" | "timed out" {
	return file.timedOut === true ? "timed out" : "failed to run";
}

/**
 * The heading every formatter titles a suite that never ran with.
 * @param file - The file result of a suite that never ran.
 * @returns The suite heading.
 */
export function execErrorTitle(file: TestFileResult): string {
	return `Test suite ${execErrorReason(file)}`;
}

/**
 * Whether a file result reports a suite that failed before any test ran.
 * @param file - The file result to check.
 * @returns True when it has a failure message and no test results.
 */
export function hasExecError(file: TestFileResult): file is ExecErrorTestFileResult {
	return (
		file.failureMessage !== undefined &&
		file.failureMessage !== "" &&
		file.testResults.length === 0
	);
}
