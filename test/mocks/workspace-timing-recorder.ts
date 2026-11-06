import { vi } from "vitest";

import type { TimedPhase, TimingCollector } from "#src/timing/orchestration-collector.ts";
import { NOOP_PROGRESS } from "#test/mocks/noop-progress.ts";

export interface TimingRecorder {
	collector: TimingCollector;
	paths: Array<string>;
}

export function recordingTimingCollector(): TimingRecorder {
	const paths: Array<string> = [];
	const runners = phaseRunners(paths);

	const collector: TimingCollector = {
		...runners,
		enabled: true,
		flushTimingReport: vi.fn<TimingCollector["flushTimingReport"]>(),
		profile: (name, func) => runners.profileTimed(name, func).value,
		profileAsync: async (name, func) => {
			const timed = await runners.profileTimedAsync(name, func);
			return timed.value;
		},
		progress: NOOP_PROGRESS,
	};

	return { collector, paths };
}

function phaseRunners(
	paths: Array<string>,
): Pick<TimingCollector, "profileTimed" | "profileTimedAsync" | "record"> {
	const stack: Array<string> = [];

	function open(name: string): void {
		stack.push(name);
		paths.push(stack.join(" > "));
	}

	return {
		profileTimed: <T>(name: string, func: () => T): TimedPhase<T> => {
			open(name);
			try {
				return { elapsedMs: 0, value: func() };
			} finally {
				stack.pop();
			}
		},
		profileTimedAsync: async <T>(name: string, func: () => Promise<T>) => {
			open(name);
			try {
				return { elapsedMs: 0, value: await func() };
			} finally {
				stack.pop();
			}
		},
		record: (name) => {
			paths.push([...stack, name].join(" > "));
		},
	};
}
