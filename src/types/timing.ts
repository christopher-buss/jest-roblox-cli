export interface TimingResult {
	coverageMs?: number | undefined;
	executionMs: number;
	setupMs?: number | undefined;
	/**
	 * The run's `PreDispatchTiming.stagingMs`, already folded into `totalMs`.
	 */
	stagingMs?: number | undefined;
	startTime: number;
	testsMs: number;
	totalMs: number;
	uploadMs?: number | undefined;
}
