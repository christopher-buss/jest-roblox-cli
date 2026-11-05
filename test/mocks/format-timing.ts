import type { TimingResult } from "../../src/types/timing-types.ts";

export const TIMING: TimingResult = {
	executionMs: 150,
	startTime: 1700000000000,
	testsMs: 100,
	totalMs: 250,
	uploadMs: 50,
};

export const TIMING_NO_UPLOAD: TimingResult = {
	executionMs: 150,
	startTime: 1700000000000,
	testsMs: 100,
	totalMs: 200,
};

export const TIMING_COVERAGE: TimingResult = {
	coverageMs: 3000,
	executionMs: 150,
	startTime: 1700000000000,
	testsMs: 100,
	totalMs: 3250,
	uploadMs: 50,
};

export const TIMING_STAGING: TimingResult = {
	executionMs: 150,
	stagingMs: 400,
	startTime: 1700000000000,
	testsMs: 100,
	totalMs: 650,
	uploadMs: 50,
};
