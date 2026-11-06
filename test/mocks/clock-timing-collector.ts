import { vi } from "vitest";

import type { TimedPhase, TimingCollector } from "#src/timing/orchestration-collector.ts";
import { NOOP_PROGRESS } from "#test/mocks/noop-progress.ts";

interface Clock {
	now: () => number;
}

const FROZEN_CLOCK: Clock = { now: () => 0 };

export function clockTimingCollector(clock: Clock = FROZEN_CLOCK): TimingCollector {
	function profileTimed<T>(_name: string, func: () => T): TimedPhase<T> {
		const start = clock.now();
		const value = func();
		return { elapsedMs: clock.now() - start, value };
	}

	async function profileTimedAsync<T>(
		_name: string,
		func: () => Promise<T>,
	): Promise<TimedPhase<T>> {
		const start = clock.now();
		const value = await func();
		return { elapsedMs: clock.now() - start, value };
	}

	return {
		enabled: false,
		flushTimingReport: vi.fn<TimingCollector["flushTimingReport"]>(),
		profile: (name, func) => profileTimed(name, func).value,
		profileAsync: async (name, func) => {
			const timed = await profileTimedAsync(name, func);
			return timed.value;
		},
		profileTimed,
		profileTimedAsync,
		progress: NOOP_PROGRESS,
		record: vi.fn<TimingCollector["record"]>(),
	};
}
