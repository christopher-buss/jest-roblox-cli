import { type Type, type } from "arktype";

/**
 * Per-package summary `luau/staging/embedded-runner.luau` streams mid-task;
 * SortedMap items cap at 32 KB.
 */
export interface StreamingResultEntry {
	/** Wall time the package run took, in milliseconds. */
	elapsedMs: number;
	/** Failed test count. */
	numFailedTests: number;
	/** Passed test count. */
	numPassedTests: number;
	/** Pending (skipped or todo) test count. */
	numPendingTests: number;
	/** Package name. */
	pkg: string;
	/** Jest project display name within the package. */
	project: string;
	/** Whether the package run passed. */
	success: boolean;
}

/** Decodes one {@link StreamingResultEntry}. */
export const streamingResultSchema: Type<StreamingResultEntry> = type({
	elapsedMs: "number",
	numFailedTests: "number",
	numPassedTests: "number",
	numPendingTests: "number",
	pkg: "string",
	project: "string",
	success: "boolean",
});
