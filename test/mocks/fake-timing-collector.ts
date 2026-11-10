import { fromAny } from "@total-typescript/shoehorn";

import { vi } from "vitest";

import type { TimingCollector } from "#src/timing/orchestration-collector.ts";
import { NOOP_PROGRESS } from "#test/mocks/noop-progress.ts";

export function fakeTimingCollector(elapsedMs = 0): TimingCollector {
	return fromAny<TimingCollector, unknown>({
		enabled: true,
		flushTimingReport: vi.fn(),
		profile: vi.fn((_name: string, func: () => unknown) => func()),
		profileAsync: vi.fn(async (_name: string, func: () => Promise<unknown>) => func()),
		profileTimed: vi.fn((_name: string, func: () => unknown) => {
			return {
				elapsedMs,
				value: func(),
			};
		}),
		profileTimedAsync: vi.fn(async (_name: string, func: () => Promise<unknown>) => {
			return {
				elapsedMs,
				value: await func(),
			};
		}),
		progress: NOOP_PROGRESS,
		record: vi.fn(),
	});
}

export function phaseNamesOf(
	member: (name: string, ...rest: Array<never>) => unknown,
): Array<string> {
	return vi.mocked(member).mock.calls.map(([name]) => name);
}
