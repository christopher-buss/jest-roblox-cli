import { describe, expect, it } from "vitest";

import type { TimingResult } from "../types/timing-types.ts";
import { buildDurationBreakdown } from "./duration-breakdown.ts";

const TIMING = {
	coverageMs: 30,
	executionMs: 500,
	setupMs: 20,
	stagingMs: 10,
	startTime: 0,
	testsMs: 300,
	totalMs: 700,
	uploadMs: 40,
} satisfies TimingResult;

describe(buildDurationBreakdown, () => {
	it("should name the window's phases and take every outside phase from cli", () => {
		expect.assertions(1);

		expect(
			buildDurationBreakdown(TIMING, { residual: "wait", work: "work", workMs: 100 }),
		).toStrictEqual([
			"upload 40ms",
			"wait 380ms",
			"setup 20ms",
			"work 100ms",
			"cli 120ms",
			"staging 10ms",
			"coverage 30ms",
		]);
	});
});
