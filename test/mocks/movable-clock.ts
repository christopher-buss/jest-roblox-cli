import type { TimingCollector } from "#src/timing/orchestration-collector.ts";
import { clockTimingCollector } from "#test/mocks/clock-timing-collector.ts";

export interface MovableClockCollector {
	advance: (byMs: number) => void;
	timing: TimingCollector;
}

export function movableClockCollector(startMs: number): MovableClockCollector {
	let now = startMs;
	return {
		advance: (byMs: number) => {
			now += byMs;
		},
		timing: clockTimingCollector({ now: () => now }),
	};
}

export function tickingClockCollector(startMs: number, stepMs: number): TimingCollector {
	let now = startMs;
	return clockTimingCollector({
		now: () => {
			now += stepMs;
			return now;
		},
	});
}
