import {
	createTimingCollector,
	type TimingCollector,
} from "../../src/timing/orchestration-collector.ts";

export interface MovableClockCollector {
	/** Moves the clock forward, from inside the phase under measurement. */
	advance: (byMs: number) => void;
	timing: TimingCollector;
}

/**
 * A collector on a clock the test drives, for asserting the phase durations a
 * run reports. Disabled, so it measures without writing a timing report — the
 * Duration line those numbers feed prints either way.
 *
 * Synchronous phases have no other way to acquire a duration: nothing yields,
 * so a real clock reads the same value at both ends. Move this one from inside
 * the mock the phase calls.
 */
export function movableClockCollector(startMs: number): MovableClockCollector {
	let now = startMs;
	return {
		advance: (byMs: number) => {
			now += byMs;
		},
		timing: createTimingCollector({ clock: { now: () => now }, enabled: false }),
	};
}

/**
 * {@link movableClockCollector} for a phase with nothing to move the clock
 * from: every reading advances it by `stepMs`, so any phase at all reports a
 * duration above zero. Use where the assertion is that a phase costs
 * *something*, never where it is what the phase costs.
 */
export function tickingClockCollector(startMs: number, stepMs: number): TimingCollector {
	let now = startMs;
	return createTimingCollector({
		clock: {
			now: () => {
				now += stepMs;
				return now;
			},
		},
		enabled: false,
	});
}
