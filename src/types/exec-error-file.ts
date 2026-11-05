import type { ExecErrorTestFileResult, TestFileResult } from "./jest-result-types.ts";

/**
 * The synthetic path a suite that never ran is filed under. Jest names a file
 * result by the file it ran; a failure that happened before any file did has no
 * such name, so this stands in for one.
 */
export const EXEC_ERROR_FILE_PATH = "<exec-error>";

/**
 * How a suite that never ran is described, in the one wording every formatter
 * says it in. Both readings are failures; only a timeout names a budget the
 * reader can raise, so the reports keep them apart.
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
