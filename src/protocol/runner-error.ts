/** Stable codes the Luau runner puts on a failed run's `runner.code`. */
export const RunnerErrorCode = {
	InfiniteYield: "infinite-yield",
	JestNotFound: "jest-not-found",
	JestPathUnresolved: "jest-path-unresolved",
	NoProjects: "no-projects",
	ServiceNotFound: "service-not-found",
	Timeout: "timeout",
} as const;

/** One of the {@link RunnerErrorCode} values. */
export type RunnerErrorCode = (typeof RunnerErrorCode)[keyof typeof RunnerErrorCode];

/** How far the runner got, on a failed run's `runner.phase`. */
export const RunnerPhase = {
	ResolveJest: "resolveJest",
	ResolveProjects: "resolveProjects",
	Run: "run",
	Staging: "staging",
} as const;

/** One of the {@link RunnerPhase} values. */
export type RunnerPhase = (typeof RunnerPhase)[keyof typeof RunnerPhase];

/** The runner's message for a run abandoned at its budget; `%g` is seconds. */
export const RUNNER_TIMEOUT_FORMAT =
	"Timed out after %gs, aborting tests. Raise test.projectTimeout";

/** Why the runner gave up on a run, on a failed run's `runner.abandon`. */
export const RunnerAbandon = {
	Timeout: "timeout",
} as const;

/** One of the {@link RunnerAbandon} values. */
export type RunnerAbandon = (typeof RunnerAbandon)[keyof typeof RunnerAbandon];
