import type { BackendTiming } from "../backends/interface.ts";
import { parseGameOutput } from "../game-output/game-output.ts";
import type { LuauScriptError } from "../jest-output/luau-script-error.ts";
import type { GameOutputEntry } from "../protocol/game-output.ts";
import type { RunnerPhase } from "../protocol/runner-error.ts";
import { EXEC_ERROR_FILE_PATH } from "../types/exec-error-file.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import type { TimingResult } from "../types/timing-types.ts";
import { composeEntryDisplayName } from "../utils/display-name.ts";
import type { ExecuteResult } from "./executor-types.ts";

const EXIT_CODE_MESSAGE = /^Exited with code: \d+$/;

/** Inputs for `buildExecutionErrorResult`. */
export interface ExecutionErrorOptions {
	/** Upload and execution timing the backend reported. */
	backendTiming: BackendTiming;
	/** The entry that failed. */
	entry: ExecErrorEntry;
	/** The decoded Luau script failure. */
	error: LuauScriptError;
	/** Run start time, in epoch milliseconds. */
	startTime: number;
}

interface ExecErrorEntry {
	pkg?: string | undefined;
	project: string;
	testFileCount: number;
}

/**
 * Build a failed result with one exec-error file for a Luau script failure.
 * @param options - The failure, its entry, config and timing.
 * @returns A failed result with one exec-error file.
 */
export function buildExecutionErrorResult({
	backendTiming,
	entry,
	error,
	startTime,
}: ExecutionErrorOptions): ExecuteResult {
	const result = buildExecErrorJestResult({ entry, error, startTime });
	const timing = buildErrorTiming(backendTiming, startTime);

	return { exitCode: 1, gameOutput: error.gameOutput, result, timing };
}

const PHASE_LABELS: Record<RunnerPhase, string> = {
	resolveJest: "resolving the Jest module",
	resolveProjects: "resolving project and setup-file instances",
	run: "running Jest",
	staging: "staging the package into the DataModel",
};

const GAME_OUTPUT_TAIL = 5;

const LABEL_WIDTH = 13;

function bannerCause(error: LuauScriptError): string | undefined {
	const entries = parseGameOutput(error.bannerOutput);
	const lines = entries
		.map((banner) => banner.message)
		.join("\n")
		.trim();
	return lines === "" ? undefined : lines;
}

function isRunnerPhase(phase: string): phase is RunnerPhase {
	return Object.hasOwn(PHASE_LABELS, phase);
}

function phaseLabel(phase: string | undefined): string {
	if (phase === undefined) {
		return "not reported by the runner";
	}

	return isRunnerPhase(phase) ? PHASE_LABELS[phase] : phase;
}

function captureNote({ captureInstalled }: LuauScriptError): string {
	if (captureInstalled === undefined) {
		return "the runner does not report whether stdout/stderr was intercepted";
	}

	return captureInstalled
		? "stdout/stderr intercepted; Jest wrote nothing"
		: "stdout/stderr interception could not be installed";
}

function gameOutputNote(entryCount: number): string {
	return `${String(entryCount)} lines captured; the last of them follow`;
}

function gameOutputTail(entries: Array<GameOutputEntry>): Array<string> {
	const lines: Array<string> = [];
	const tail = entries.slice(-GAME_OUTPUT_TAIL);
	for (const entry of tail) {
		const trimmed = entry.message.trim();
		if (trimmed !== "") {
			lines.push(trimmed);
		}
	}

	return lines;
}

function buildDiagnosticReport(error: LuauScriptError, entry: ExecErrorEntry): string {
	const gameEntries = parseGameOutput(error.gameOutput);
	const tail = gameOutputTail(gameEntries);

	const rows: Array<[label: string, value: string]> = [
		["Project", composeEntryDisplayName(entry.pkg, entry.project)],
		["Phase", phaseLabel(error.phase)],
		["Test files", `${String(entry.testFileCount)} selected by the host`],
		["Capture", captureNote(error)],
		["Game Output", tail.length > 0 ? gameOutputNote(gameEntries.length) : "nothing captured"],
	];

	const lines = [
		"Jest exited before returning a result, and no cause was captured.",
		"",
		...rows.map(([label, value]) => `  ${label.padEnd(LABEL_WIDTH)}${value}`),
	];

	if (tail.length > 0) {
		lines.push("", ...tail.map((line) => `    ${line}`));
	}

	return lines.join("\n");
}

/**
 * Mirrors exit-code-only handling in `formatLuauErrorBanner` (cli-errors.ts).
 *
 * @param error - The Luau script failure.
 * @param entry - The entry that failed.
 * @returns The failure message.
 */
function composeExecErrorMessage(error: LuauScriptError, entry: ExecErrorEntry): string {
	if (!EXIT_CODE_MESSAGE.test(error.message)) {
		return error.message;
	}

	const cause = bannerCause(error);
	if (cause !== undefined) {
		return `${cause}\n\n${error.message}`;
	}

	return `${buildDiagnosticReport(error, entry)}\n\n${error.message}`;
}

function buildExecErrorJestResult({
	entry,
	error,
	startTime,
}: {
	entry: ExecErrorEntry;
	error: LuauScriptError;
	startTime: number;
}): JestResult {
	// Shape must match what `hasExecError` detects.
	return {
		numFailedTests: 0,
		numPassedTests: 0,
		numPendingTests: 0,
		numTotalTests: 0,
		startTime,
		success: false,
		testResults: [
			{
				failureMessage: composeExecErrorMessage(error, entry),
				numFailingTests: 0,
				numPassingTests: 0,
				numPendingTests: 0,
				testFilePath: EXEC_ERROR_FILE_PATH,
				testResults: [],
				timedOut: error.timedOut,
			},
		],
	};
}

function buildErrorTiming(backendTiming: BackendTiming, startTime: number): TimingResult {
	return {
		executionMs: backendTiming.executionMs,
		startTime,
		testsMs: 0,
		totalMs: Date.now() - startTime,
		uploadMs: backendTiming.uploadMs,
	};
}
