import process from "node:process";

import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { nodeRunSeams, type RunSeams } from "./seams.ts";

/** What a run reads and writes through. */
export interface RunEntryOptions {
	/** Where the run reads and writes. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/** Host seams the run uses. Defaults to the real ones. */
	seams?: RunSeams;
}

/**
 * Whether the `TIMING` environment variable asks for the timing report.
 * @returns True when `TIMING` is set.
 */
export function readTimingSetting(): boolean {
	return process.env["TIMING"] !== undefined;
}

/**
 * Settle every run entry's omitted options on the Node implementations, once.
 * @param options - The caller's run options.
 * @returns Run options with nothing left to default.
 */
export function settleRunEntry(options: RunEntryOptions): Required<RunEntryOptions> {
	return {
		fileSystem: nodeFileSystem,
		seams: nodeRunSeams(),
		...options,
	};
}
