import type { BackendTiming } from "../backends/interface.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { LuauScriptError } from "../reporter/parser.ts";
import type { GameOutputEntry } from "../types/game-output.ts";
import { EXEC_ERROR_FILE_PATH } from "../types/jest-result.ts";
import type { JestResult } from "../types/jest-result.ts";
import type { TimingResult } from "../types/timing.ts";
import { composeEntryDisplayName } from "../utils/display-name.ts";
import { parseGameOutput } from "../utils/game-output.ts";
import { formatExecuteOutput } from "./format-output.ts";
import type { ExecuteResult } from "./types.ts";

const EXIT_CODE_MESSAGE = /^Exited with code: \d+$/;

/**
 * What the host knows about the entry a failure came back on, before anything
 * the runtime captured is read.
 *
 * This is the half of a failure that survives a run which produced no output
 * at all, so it is what the report falls back to rather than leaving the
 * reader with a bare exit code.
 */
export interface ExecErrorEntry {
	/** Workspace mode only: the package that owns the project. */
	pkg?: string | undefined;
	project: string;
	/** How many test files the host selected for this entry. */
	testFileCount: number;
}

export interface ExecutionErrorOptions {
	backendTiming: BackendTiming;
	config: ResolvedConfig;
	deferFormatting: boolean | undefined;
	entry: ExecErrorEntry;
	error: LuauScriptError;
	startTime: number;
	version: string;
}

/**
 * Build an `ExecuteResult` representing an entry whose envelope decoded to a
 * Luau-level script failure. Synthesizes a JestResult with a single
 * "exec-error" file so the failure shows up in formatted output and
 * per-package output files, without halting sibling processing.
 */
export function buildExecutionErrorResult({
	backendTiming,
	config,
	deferFormatting,
	entry,
	error,
	startTime,
	version,
}: ExecutionErrorOptions): ExecuteResult {
	const result = buildExecErrorJestResult(error, entry, startTime);
	const timing = buildErrorTiming(backendTiming, startTime);

	const output =
		deferFormatting !== true ? formatExecuteOutput({ config, result, timing, version }) : "";

	return {
		exitCode: 1,
		gameOutput: error.gameOutput,
		output,
		result,
		timing,
	};
}

// How the phases the Luau runners name read to someone who has never opened
// them. An id with no entry here renders as itself: a runner that grows a
// phase then says something truer than "unknown" would, even before this map
// catches up with it.
const PHASE_LABELS: Record<string, string> = {
	resolveJest: "resolving the Jest module",
	resolveProjects: "resolving project and setup-file instances",
	run: "running Jest",
	staging: "staging the package into the DataModel",
};

// Enough trailing Game Output to carry the line Jest printed on its way out —
// an intercepted `process.stdout` still delegates to `print`, so LogService
// sees it too — without pasting a whole run's log into a failure message.
const GAME_OUTPUT_TAIL = 5;

const LABEL_WIDTH = 13;

/**
 * The captured cause, or undefined when there is none to lead with.
 *
 * Banner Output (Jest's process.stdout) is where the exit cause lives —
 * "No tests found, exiting with code 1" is written via Jest's reporter, not
 * via the native print/warn that only LogService would capture.
 */
function bannerCause(error: LuauScriptError): string | undefined {
	const entries = parseGameOutput(error.bannerOutput);
	if (entries.length === 0) {
		return undefined;
	}

	const lines = entries
		.map((banner) => banner.message)
		.join("\n")
		.trim();
	return lines === "" ? undefined : lines;
}

function phaseLabel(phase: string | undefined): string {
	if (phase === undefined) {
		return "not reported by the runner";
	}

	return PHASE_LABELS[phase] ?? phase;
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

/**
 * The trailing Game Output lines, blank ones dropped.
 *
 * Offered as what they are — the end of the log, not the cause — because the
 * capture window closes on the package's teardown, so the very last line is as
 * likely to be a stage reset as the message Jest exited on.
 */
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

/**
 * What the host can say about a failure that captured no cause of its own.
 *
 * Every row is a fact the host holds however little the run produced, so this
 * reports rather than concludes: an exit code alone does not say the run found
 * no tests, and naming one cause out of the several that exit this way would
 * send the reader after the wrong one.
 */
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
 * Compose the human-readable failure message for an exec-error file
 * synthesized from a Luau script failure.
 *
 * When the wire-level error is just `Exited with code: N`, the actual
 * Jest cause (`No tests found`, `passWithNoTests` guidance, etc.) lives
 * in the captured banner output, not the rejection message itself. The
 * existing single-mode CLI banner (`cli.ts#formatLuauErrorBanner`)
 * surfaces that game output as the primary content for exit-code-only
 * errors; mirror the same semantics here so workspace-mode and
 * multi-project recovery don't drop the user-actionable cause.
 *
 * Format: the captured cause first, then a blank line, then the raw exit-code
 * message as a footer. When nothing was captured there is no cause to lead
 * with, and the report the host can always build takes that place instead —
 * see {@link buildDiagnosticReport}.
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

function buildExecErrorJestResult(
	error: LuauScriptError,
	entry: ExecErrorEntry,
	startTime: number,
): JestResult {
	// Exec-error file shape (see `hasExecError`): `failureMessage` set with
	// empty `testResults` — the file errored before any tests ran, so
	// `numFailingTests`/`numFailedTests`/`numTotalTests` all stay 0.
	// Formatters key off `hasExecError` to count this as a failed FILE
	// (not a failed test).
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
				// A field rather than a second synthetic path: the source
				// mapper rewrites every `testFilePath` it can resolve, and a
				// JSON consumer reads this without knowing which strings the
				// CLI reserves.
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
