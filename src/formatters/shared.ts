/**
 * Vocabulary every formatter module shares: the option and context shapes that
 * thread through the render tree, plus the two lookups (display path, terminal
 * width) each of them needs. Kept as the dependency leaf so no formatter module
 * has to import a sibling just to name an option.
 */

import process from "node:process";

import type { SourceMapper } from "../source-mapper/index.ts";
import type { JestResult } from "../types/jest-result.ts";

export interface FormatOptions {
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

export function resolveDisplayPath(testFilePath: string, sourceMapper?: SourceMapper): string {
	return sourceMapper?.resolveDisplayPath(testFilePath) ?? testFilePath;
}

export function getTerminalWidth(): number {
	return ("columns" in process.stdout && process.stdout.columns) || 80;
}
