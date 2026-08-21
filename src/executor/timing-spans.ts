import process from "node:process";

import type { BackendTiming, RawBackendEntry } from "../backends/interface.ts";
import { extractLuauTimingFromOutput } from "../reporter/parser.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { TestFileResult } from "../types/jest-result.ts";

export function recordBackendTimingSpans(
	timing: TimingCollector,
	backendTiming: BackendTiming,
): void {
	// `uploadMs` is optional in the BackendTiming shape — studio backend
	// doesn't upload — so skip the span when the backend didn't report one.
	if (backendTiming.uploadMs !== undefined) {
		timing.record("uploadMs", backendTiming.uploadMs);
	}

	timing.record("executionMs", backendTiming.executionMs);
}

// Surfaces each project's Luau-side phase breakdown (findJest, jestRunCLI,
// etc.) as nested spans of `backend.runTests`, matching uploadMs/executionMs.
// Phases are prefixed `luau.` so they group together and read distinctly
// from the host-measured spans; repeated phases across projects accumulate,
// same as uploadMs. The raw `total` key is skipped — it's the Luau-measured
// wall clock for the whole run, and a second "total" leaf next to the host's
// own executionMs would read as double-counting even though the tree math
// doesn't actually double it.
//
// Gated on `timing.enabled` (unlike `recordBackendTimingSpans`, whose
// `record` calls are already free): extracting `runner.timing` re-parses each
// project's full jestOutput, which is wasted work on an ordinary run where
// TIMING isn't set (the Luau side doesn't even emit `runner.timing` then)
// and would otherwise put a parse/schema-assert failure on the
// `backend.runTests` frame of every non-debug run.
export function recordLuauTimingSpans(
	timing: TimingCollector,
	rawResults: Array<RawBackendEntry>,
): void {
	if (!timing.enabled) {
		return;
	}

	for (const raw of rawResults) {
		const luauTiming = extractLuauTimingFromOutput(raw.entry.jestOutput);
		if (luauTiming !== undefined) {
			recordLuauPhases(timing, luauTiming);
		}
	}
}

export function calculateTestsMs(testResults: Array<TestFileResult>): number {
	let total = 0;
	for (const file of testResults) {
		for (const test of file.testResults) {
			if (test.duration !== undefined) {
				total += test.duration;
			}
		}
	}

	return total;
}

export function printLuauTiming(timing: Record<string, number>): void {
	let total = 0;
	for (const [phase, seconds] of Object.entries(timing)) {
		const ms = Math.round(seconds * 1000);
		total += ms;
		process.stderr.write(`[TIMING] ${phase}: ${String(ms)}ms\n`);
	}

	process.stderr.write(`[TIMING] total: ${String(total)}ms\n`);
}

function recordLuauPhases(timing: TimingCollector, luauTiming: Record<string, number>): void {
	for (const [phase, seconds] of Object.entries(luauTiming)) {
		if (phase !== "total") {
			timing.record(`luau.${phase}`, seconds * 1000);
		}
	}
}
