/**
 * Vocabulary every formatter module shares: the option and context shapes that
 * thread through the render tree, plus the two lookups (display path, terminal
 * width) each of them needs. Kept as the dependency leaf so no formatter module
 * has to import a sibling just to name an option.
 */

import process from "node:process";

import type { SourceMapper } from "../source-mapper/index.ts";
import type { JestResult } from "../types/jest-result-types.ts";

/** Packages a bailed run reached, and packages it never started. */
export interface BailSummary {
	/**
	 * Packages the run never started.
	 */
	notRun: number;
	/**
	 * Packages the run started, the failing one included.
	 */
	ran: number;
}

/**
 * Options every formatter reads.
 */
export interface FormatOptions {
	/**
	 * Workspace `--bail` only: how far the run got before a failing package
	 * stopped it. Absent on a run that reached every package.
	 */
	bail?: BailSummary | undefined;
	/**
	 * Announce coverage collection in the header.
	 */
	collectCoverage?: boolean | undefined;
	/**
	 * Emit ANSI color.
	 */
	color: boolean;
	/**
	 * Omit files with no failing test and no execution error.
	 */
	failuresOnly?: boolean | undefined;
	/**
	 * Path of the written Roblox game log, named in the footer.
	 */
	gameOutput?: string | undefined;
	/**
	 * Path of the written full Jest output, named in the footer.
	 */
	outputFile?: string | undefined;
	/**
	 * Directory that displayed paths are relative to.
	 */
	rootDir: string;
	/**
	 * Show the Luau source beside mapped TypeScript in failure snippets.
	 */
	showLuau?: boolean | undefined;
	/**
	 * Milliseconds above which a duration is styled as slow.
	 */
	slowTestThreshold?: number | undefined;
	/**
	 * Snapshots that failed to write, reported in the summary.
	 */
	snapshotWriteFailures?: number | undefined;
	/**
	 * Maps Luau paths and locations back to TypeScript source.
	 */
	sourceMapper?: SourceMapper | undefined;
	/**
	 * Type errors found, reported in the summary.
	 */
	typeErrors?: number | undefined;
	/**
	 * List each passing test under its file.
	 */
	verbose: boolean;
	/**
	 * CLI version shown in the header.
	 */
	version: string;
}

/**
 * One project's result in a multi-project render.
 */
export interface FormatterProjectEntry {
	/**
	 * Color of the project badge.
	 */
	displayColor?: string | undefined;
	/**
	 * Label of the project badge.
	 */
	displayName: string;
	/**
	 * The project's own raw Game Output, rendered under its section when it
	 * fails so the reader sees which package printed which warning. Raw so a
	 * passing project never pays to parse it.
	 */
	gameOutput?: string | undefined;
	/**
	 * The project's Jest result.
	 */
	result: JestResult;
}

/**
 * Running numbering for the detailed-failure blocks. Mutated as each failure is
 * rendered, so it is passed by reference across projects to keep one sequence.
 */
export interface FailureContext {
	/**
	 * Number of the last rendered failure block.
	 */
	currentIndex: number;
	/**
	 * Failure blocks across all projects.
	 */
	totalFailures: number;
}

/**
 * Resolve the path a test file is shown by.
 * @param testFilePath - Path Jest reported for the test file.
 * @param sourceMapper - Maps the path to its source path.
 * @returns The mapped path, or `testFilePath` when none is known.
 */
export function resolveDisplayPath(testFilePath: string, sourceMapper?: SourceMapper): string {
	return sourceMapper?.resolveDisplayPath(testFilePath) ?? testFilePath;
}

/**
 * Width to wrap output at.
 * @returns Stdout column count, or 80 when stdout reports none.
 */
export function getTerminalWidth(): number {
	return ("columns" in process.stdout && process.stdout.columns) || 80;
}
