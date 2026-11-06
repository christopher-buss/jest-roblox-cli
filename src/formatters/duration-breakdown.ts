import type { TimingResult } from "../types/timing-types.ts";

/** The phases inside the execution window that a Duration row names. */
export interface WindowPhases {
	/**
	 * Name of the residual phase, what the window has left after the others.
	 */
	residual: string;
	/** Name of the measured work phase. */
	work: string;
	/** Duration of the work phase. */
	workMs: number;
}

/**
 * The residual and `cli` are what the measured phases leave unaccounted for,
 * so both are clamped at zero. The residual is what the execution window has
 * left after the phases inside it; `cli` is what the total has left after the
 * window and every phase measured outside it, so a new outside-the-window
 * phase belongs in `outsideExecutionMs` as well as in its own segment.
 * @param timing - Run timing.
 * @param window - The phases inside the execution window.
 * @returns The `<phase> <n>ms` segments of the Duration row.
 */
export function buildDurationBreakdown(timing: TimingResult, window: WindowPhases): Array<string> {
	const setupMs = timing.setupMs ?? 0;
	const residualMs = Math.max(0, timing.executionMs - window.workMs - setupMs);
	const uploadMs = timing.uploadMs ?? 0;
	const coverageMs = timing.coverageMs ?? 0;
	const stagingMs = timing.stagingMs ?? 0;
	const outsideExecutionMs = uploadMs + coverageMs + stagingMs;
	const cliMs = Math.max(0, timing.totalMs - timing.executionMs - outsideExecutionMs);
	const parts: Array<string> = [];

	if (timing.uploadMs !== undefined) {
		parts.push(`upload ${timing.uploadMs}ms`);
	}

	parts.push(`${window.residual} ${residualMs}ms`);

	if (setupMs > 0) {
		parts.push(`setup ${setupMs}ms`);
	}

	parts.push(`${window.work} ${window.workMs}ms`, `cli ${cliMs}ms`);

	if (stagingMs > 0) {
		parts.push(`staging ${stagingMs}ms`);
	}

	if (coverageMs > 0) {
		parts.push(`coverage ${coverageMs}ms`);
	}

	return parts;
}
