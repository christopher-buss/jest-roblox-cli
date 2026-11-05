/** Phase durations of one run, in milliseconds. */
export interface TimingResult {
	/** Time spent processing coverage. */
	coverageMs?: number | undefined;
	/** Time the backend spent in execution. */
	executionMs: number;
	/** Time Jest spent in setup before the tests ran. */
	setupMs?: number | undefined;
	/**
	 * The run's `PreDispatchTiming.stagingMs`, already folded into `totalMs`.
	 */
	stagingMs?: number | undefined;
	/** When the run started, as epoch milliseconds. */
	startTime: number;
	/** Time Jest spent running the tests. */
	testsMs: number;
	/** Wall time of the whole run. */
	totalMs: number;
	/** Time spent uploading the place. */
	uploadMs?: number | undefined;
}
