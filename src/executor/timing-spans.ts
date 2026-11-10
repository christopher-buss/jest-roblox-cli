import type { BackendTiming, RawBackendEntry } from "../backends/interface.ts";
import { extractLuauTimingFromOutput } from "../jest-output/parser.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { TestFileResult } from "../types/jest-result-types.ts";

/**
 * Record the backend's upload and execution spans.
 * @param timing - Collector to record into.
 * @param backendTiming - Timing the backend reported.
 */
export function recordBackendTimingSpans(
	timing: TimingCollector,
	backendTiming: BackendTiming,
): void {
	if (backendTiming.uploadMs !== undefined) {
		timing.record("uploadMs", backendTiming.uploadMs);
	}

	timing.record("executionMs", backendTiming.executionMs);
}

/**
 * Record each project's Luau phase breakdown as `luau.*` spans.
 * @param timing - Collector to record into.
 * @param rawResults - Raw backend entries whose Jest output holds the timing.
 */
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

/**
 * Sum the durations of all tests.
 * @param testResults - Test file results to sum.
 * @returns Total test duration in milliseconds; tests with no duration count as zero.
 */
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

function recordLuauPhases(timing: TimingCollector, luauTiming: Record<string, number>): void {
	for (const [phase, seconds] of Object.entries(luauTiming)) {
		if (phase !== "total") {
			timing.record(`luau.${phase}`, seconds * 1000);
		}
	}
}
