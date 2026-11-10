import assert from "node:assert";

import type { MappedLocation, SourceMapper } from "../source-mapper/index.ts";
import { formatBannerBar } from "../terminal/banner.ts";
import type { Styles } from "../terminal/palette.ts";
import { getTerminalWidth } from "../terminal/width.ts";
import { execErrorTitle, hasExecError } from "../types/exec-error-file.ts";
import type { ExecErrorTestFileResult, JestResult } from "../types/jest-result-types.ts";
import {
	cleanExecErrorMessage,
	getExecErrorHint,
	type ParsedError,
	parseErrorMessage,
} from "./failure-message.ts";

// The bounded path length keeps the unanchored match from backtracking.
const SOURCE_LOCATION = /([^\s:]{1,512}\.(?:tsx?|luau?)):(\d+)(?::(\d+))?/;

/** The three buckets a summary row counts, whatever it is counting. */
export interface SummaryCounts {
	/** Files or tests that failed. */
	failed: number;
	/** Files or tests that passed. */
	passed: number;
	/** Files or tests that were skipped. */
	skipped: number;
}

/** A source position a failure points at. */
export interface FailureLocation {
	/** Column, when known. */
	column?: number | undefined;
	/** Line number. */
	line: number;
	/** File path. */
	path: string;
}

/** One failure message, mapped back to source and parsed. */
export interface LocatedFailure {
	/** Every location the source mapper resolved, in message order. */
	locations: Array<MappedLocation>;
	/** The message with Luau paths rewritten to source paths. */
	message: string;
	/** The raw message split into its first line and any diff. */
	parsed: ParsedError;
	/**
	 * Where the failure happened: the first mapped location (TypeScript when
	 * it mapped, else Luau), else the first location written in the message.
	 */
	primary: FailureLocation | undefined;
}

/** What a failure shows under its first message line. */
export type FailureDetail =
	| { diff: string; kind: "snapshot" }
	| { expected: string; kind: "values"; received: string }
	| { kind: "message" };

/** A source a snippet is read from. */
export type SnippetSource =
	| { kind: "mapped"; location: MappedLocation }
	| { kind: "message"; location: FailureLocation };

/** A suite that threw before its tests ran, as every formatter states it. */
export interface ExecErrorBlock {
	/** Badge the block leads with. */
	badge: "FAIL" | "TIMEOUT";
	/** Setup hint for a known error. */
	hint: string | undefined;
	/** Cleaned error message. */
	message: string;
	/** Why the suite stopped. */
	title: string;
}

/** Where the run wrote its logs, named in the hints after a failed run. */
export interface LogHintSources {
	/** Path of the Roblox game log. */
	gameOutput?: string | undefined;
	/** Path of the full Jest output. */
	outputFile?: string | undefined;
}

/**
 * Count a run's files by bucket; skip and pass follow vitest's file `mode`.
 * @param result - Jest result whose files to bucket.
 * @returns How many files failed, passed and skipped.
 */
export function countFileBuckets(result: JestResult): SummaryCounts {
	let failed = 0;
	let skipped = 0;

	for (const file of result.testResults) {
		if (file.numFailingTests > 0 || hasExecError(file)) {
			failed++;
		} else if (file.numPassingTests === 0 && file.numPendingTests > 0) {
			skipped++;
		}
	}

	return { failed, passed: result.testResults.length - failed - skipped, skipped };
}

/**
 * Map a failure message to source and pick the location it happened at.
 * @param originalMessage - Raw failure message.
 * @param sourceMapper - Maps Luau locations back to TypeScript.
 * @returns The mapped message, its locations, the primary one and the parse.
 */
export function locateFailure(
	originalMessage: string,
	sourceMapper: SourceMapper | undefined,
): LocatedFailure {
	const mapper = originalMessage === "" ? undefined : sourceMapper;
	const { locations, message } = mapper?.mapFailureWithLocations(originalMessage) ?? {
		locations: [],
		message: originalMessage,
	};

	return {
		locations,
		message,
		parsed: parseErrorMessage(originalMessage),
		primary: primaryLocation(locations[0]) ?? parseSourceLocation(message),
	};
}

/**
 * The detail a failure shows: a snapshot diff, an expected/received pair, or
 * only the message when neither was parsed out.
 * @param parsed - The message split into its first line and any diff.
 * @returns Which detail the failure shows, with its parts.
 */
export function failureDetail(parsed: ParsedError): FailureDetail {
	if (parsed.snapshotDiff !== undefined) {
		return { diff: parsed.snapshotDiff, kind: "snapshot" };
	}

	if (parsed.expected !== undefined && parsed.received !== undefined) {
		return { expected: parsed.expected, kind: "values", received: parsed.received };
	}

	return { kind: "message" };
}

/**
 * The sources that best explain a failure: every mapped location, else the
 * location written in the message.
 * @param failure - Failure whose mapped locations and message to read.
 * @returns The sources, best first; empty when the failure names none.
 */
export function snippetSources(failure: LocatedFailure): Array<SnippetSource> {
	if (failure.locations.length > 0) {
		return failure.locations.map((location) => ({ kind: "mapped", location }));
	}

	return failure.primary !== undefined ? [{ kind: "message", location: failure.primary }] : [];
}

/**
 * State a suite that threw: its badge, title, cleaned message and setup hint.
 * @param file - File whose suite threw.
 * @returns The block every formatter renders.
 */
export function describeExecError(file: ExecErrorTestFileResult): ExecErrorBlock {
	const message = cleanExecErrorMessage(file.failureMessage);
	return {
		badge: file.timedOut === true ? "TIMEOUT" : "FAIL",
		hint: getExecErrorHint(message),
		message,
		title: execErrorTitle(file),
	};
}

/**
 * The `Failed Tests N` bar. With `rule` set, that many glyphs flank the title;
 * otherwise the bar fills the terminal.
 * @param failCount - Failures shown in the title.
 * @param options - Palette, and the glyphs on each side of the title.
 * @param options.rule - Glyphs on each side of the title.
 * @param options.styles - Palette to paint with.
 * @returns The bar.
 */
export function formatFailedTestsHeader(
	failCount: number,
	{ rule, styles }: { rule?: number; styles: Styles },
): string {
	const title = `Failed Tests ${failCount}`;
	return formatBannerBar({
		level: "error",
		styles,
		termWidth: rule === undefined ? getTerminalWidth() : title.length + 2 + rule * 2,
		title,
	});
}

/**
 * Where to read the full output of a failed run.
 * @param sources - Log paths.
 * @returns One line per written log.
 */
export function formatLogHintLines(sources: LogHintSources): Array<string> {
	const lines: Array<string> = [];

	if (sources.outputFile !== undefined) {
		lines.push(`View ${sources.outputFile} for full Jest output`);
	}

	if (sources.gameOutput !== undefined) {
		lines.push(`View ${sources.gameOutput} for Roblox game logs`);
	}

	return lines;
}

function parseSourceLocation(message: string): FailureLocation | undefined {
	const match = message.match(SOURCE_LOCATION);
	if (match === null) {
		return undefined;
	}

	const [, filePath, lineString, columnString] = match;
	assert(filePath !== undefined);
	assert(lineString !== undefined);

	return {
		column: columnString !== undefined ? Number.parseInt(columnString, 10) : undefined,
		line: Number.parseInt(lineString, 10),
		path: filePath,
	};
}

function primaryLocation(location: MappedLocation | undefined): FailureLocation | undefined {
	if (location === undefined) {
		return undefined;
	}

	if (location.tsPath !== undefined && location.tsLine !== undefined) {
		return { column: location.tsColumn, line: location.tsLine, path: location.tsPath };
	}

	return { line: location.luauLine, path: location.luauPath };
}
