import type { BackendTiming } from "../backends/interface.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { LuauScriptError } from "../reporter/parser.ts";
import type { JestResult } from "../types/jest-result.ts";
import type { TimingResult } from "../types/timing.ts";
import { parseGameOutput } from "../utils/game-output.ts";
import { formatExecuteOutput } from "./format-output.ts";
import type { ExecuteResult } from "./types.ts";

const EXIT_CODE_MESSAGE = /^Exited with code: \d+$/;

export interface ExecutionErrorOptions {
	backendTiming: BackendTiming;
	config: ResolvedConfig;
	deferFormatting: boolean | undefined;
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
	error,
	startTime,
	version,
}: ExecutionErrorOptions): ExecuteResult {
	const result = buildExecErrorJestResult(error, startTime);
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

/**
 * Compose the human-readable failure message for an exec-error file
 * synthesized from a Luau script failure.
 *
 * When the wire-level error is just `Exited with code: N`, the actual
 * Jest cause (`No tests found`, `passWithNoTests` guidance, etc.) lives
 * in the captured game output, not the rejection message itself. The
 * existing single-mode CLI banner (`cli.ts#formatLuauErrorBanner`)
 * surfaces that game output as the primary content for exit-code-only
 * errors; mirror the same semantics here so workspace-mode and
 * multi-project recovery don't drop the user-actionable cause.
 *
 * Format: meaningful game-output lines first, then a blank line, then
 * the raw exit-code message as a footer. `cleanExecErrorMessage`
 * (formatter.ts/agent.ts) takes the first non-empty content line so the
 * meaningful cause surfaces in human/agent formatters; JSON formatter
 * preserves the full multi-line text for structured consumers.
 */
function composeExecErrorMessage(error: LuauScriptError): string {
	if (!EXIT_CODE_MESSAGE.test(error.message)) {
		return error.message;
	}

	// Banner Output (Jest's process.stdout) is where the exit cause lives —
	// "No tests found, exiting with code 1" is written via Jest's reporter,
	// not via native print/warn that LogService would capture.
	const entries = parseGameOutput(error.bannerOutput);
	if (entries.length === 0) {
		return error.message;
	}

	const gameLines = entries
		.map((entry) => entry.message)
		.join("\n")
		.trim();
	if (gameLines === "") {
		return error.message;
	}

	return `${gameLines}\n\n${error.message}`;
}

function buildExecErrorJestResult(error: LuauScriptError, startTime: number): JestResult {
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
				failureMessage: composeExecErrorMessage(error),
				numFailingTests: 0,
				numPassingTests: 0,
				numPendingTests: 0,
				testFilePath: "<exec-error>",
				testResults: [],
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
