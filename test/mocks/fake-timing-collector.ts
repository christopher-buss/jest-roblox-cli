import { fromAny } from "@total-typescript/shoehorn";

import { vi } from "vitest";

import { NOOP_RUN_PROGRESS } from "../../src/progress/reporter.ts";
import type { TimingCollector } from "../../src/timing/orchestration-collector.ts";

/**
 * A collector whose every phase runs straight through and reports the same
 * fixed duration. For specs that assert which phases a unit opens, and how it
 * combines the durations it gets back, without driving a clock — `vi.fn` on
 * each member, so the phase names are readable off `.mock.calls`.
 *
 * One `elapsedMs` for every phase is the point: a spec that sums two phases
 * asserts `2 * elapsedMs` and so cannot pass by reading only one of them.
 */
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
		progress: NOOP_RUN_PROGRESS,
		record: vi.fn(),
	});
}

/**
 * The phase names a {@link fakeTimingCollector} member was called with, in
 * order. Takes the member itself rather than a name so a typo names a member
 * that does not exist instead of one no call ever matched.
 */
export function phaseNamesOf(
	member: (name: string, ...rest: Array<never>) => unknown,
): Array<string> {
	return vi.mocked(member).mock.calls.map(([name]) => name);
}
