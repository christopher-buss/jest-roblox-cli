/**
 * Vocabulary every formatter module shares: the option and context shapes that
 * thread through the render tree, plus the two lookups (display path, terminal
 * width) each of them needs. Kept as the dependency leaf so no formatter module
 * has to import a sibling just to name an option.
 */

import process from "node:process";

import type { SourceMapper } from "../source-mapper/index.ts";
import type { JestResult } from "../types/jest-result.ts";

/** Packages a bailed run reached, and packages it never started. */
export interface BailSummary {
	notRun: number;
	ran: number;
}

export interface FormatOptions {
	/**
	 * Workspace `--bail` only: how far the run got before a failing package
	 * stopped it. Absent on a run that reached every package.
	 */
	bail?: BailSummary | undefined;
	collectCoverage?: boolean | undefined;
	color: boolean;
	failuresOnly?: boolean | undefined;
	gameOutput?: string | undefined;
	outputFile?: string | undefined;
	rootDir: string;
	showLuau?: boolean | undefined;
	slowTestThreshold?: number | undefined;
	snapshotWriteFailures?: number | undefined;
	sourceMapper?: SourceMapper | undefined;
	typeErrors?: number | undefined;
	verbose: boolean;
	version: string;
}

export interface FormatterProjectEntry {
	displayColor?: string | undefined;
	displayName: string;
	/**
	 * The project's own raw Game Output, rendered under its section when it
	 * fails so the reader sees which package printed which warning. Raw so a
	 * passing project never pays to parse it.
	 */
	gameOutput?: string | undefined;
	result: JestResult;
}

/**
 * Running numbering for the detailed-failure blocks. Mutated as each failure is
 * rendered, so it is passed by reference across projects to keep one sequence.
 */
export interface FailureContext {
	currentIndex: number;
	totalFailures: number;
}

/**
 * The bail line's text, without styling.
 *
 * Shared by the human and agent formatters: both have to say the report is a
 * prefix of the selection, and two wordings for one fact is how they drift.
 */
export function formatBailText({ notRun, ran }: BailSummary): {
	reached: string;
	skipped: string;
} {
	return {
		reached: `after ${ran} ${ran === 1 ? "package" : "packages"}`,
		skipped: `, ${notRun} not run`,
	};
}

export function resolveDisplayPath(testFilePath: string, sourceMapper?: SourceMapper): string {
	return sourceMapper?.resolveDisplayPath(testFilePath) ?? testFilePath;
}

export function getTerminalWidth(): number {
	return ("columns" in process.stdout && process.stdout.columns) || 80;
}
