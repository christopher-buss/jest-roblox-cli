/** The `runner*` argv keys our Luau runner reads and strips before Jest. */
export interface RunnerArgv {
	/** `false` leaves game output capture to the caller. */
	runnerCaptureGameOutput?: boolean;
	/** Collect coverage hits. */
	runnerCoverage?: boolean;
	/** Index of the job in the CLI's request, echoed on its envelope entry. */
	runnerJobIndex?: number;
	/** Attribute coverage hits to each test. */
	runnerPerTestCoverage?: boolean;
	/** Abandon the run after this many milliseconds. */
	runnerTimeoutMs?: number;
	/** Report the runner's phase timings. */
	runnerTiming?: boolean;
}

const RUNNER_KEY_SET = {
	runnerCaptureGameOutput: true,
	runnerCoverage: true,
	runnerJobIndex: true,
	runnerPerTestCoverage: true,
	runnerTimeoutMs: true,
	runnerTiming: true,
} satisfies Record<keyof RunnerArgv, true>;

/** Every {@link RunnerArgv} key, sorted. */
export const RUNNER_KEYS: ReadonlyArray<string> = Object.keys(RUNNER_KEY_SET).sort();
