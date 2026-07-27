export interface TimingResult {
	coverageMs?: number | undefined;
	executionMs: number;
	setupMs?: number | undefined;
	startTime: number;
	testsMs: number;
	totalMs: number;
	uploadMs?: number | undefined;
}
