export interface TimingResult {
	coverageMs?: number;
	executionMs: number;
	setupMs?: number;
	startTime: number;
	testsMs: number;
	totalMs: number;
	uploadCached?: boolean;
	uploadMs?: number;
}
