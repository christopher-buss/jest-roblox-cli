import { fromPartial } from "@total-typescript/shoehorn";

import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import type { RawBackendEntry } from "../backends/interface.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { TestFileResult } from "../types/jest-result.ts";
import { calculateTestsMs, printLuauTiming, recordLuauTimingSpans } from "./timing-spans.ts";

function runnerOutput(timing: Record<string, number>): string {
	return `Roblox runner log\n${JSON.stringify({ runner: { timing } })}\n`;
}

describe(calculateTestsMs, () => {
	it("should sum available durations across every file", () => {
		expect.assertions(1);

		const files = [
			fromPartial<TestFileResult>({ testResults: [{ duration: 12 }, {}] }),
			fromPartial<TestFileResult>({ testResults: [{ duration: 0 }, { duration: 8 }] }),
		];

		expect(calculateTestsMs(files)).toBe(20);
	});
});

describe(recordLuauTimingSpans, () => {
	it("should record every Luau phase except its redundant total", () => {
		expect.assertions(1);

		const record = vi.fn<TimingCollector["record"]>();
		const timing = fromPartial<TimingCollector>({ enabled: true, record });
		const rawResults = [
			fromPartial<RawBackendEntry>({
				entry: { jestOutput: runnerOutput({ findJest: 0.2, jestRunCLI: 0.3, total: 0.5 }) },
			}),
		];

		recordLuauTimingSpans(timing, rawResults);

		expect(record.mock.calls).toStrictEqual([
			["luau.findJest", 200],
			["luau.jestRunCLI", 300],
		]);
	});

	it("should skip an entry whose output carries no Luau timing", () => {
		expect.assertions(1);

		const record = vi.fn<TimingCollector["record"]>();
		const timing = fromPartial<TimingCollector>({ enabled: true, record });

		recordLuauTimingSpans(timing, [
			fromPartial<RawBackendEntry>({ entry: { jestOutput: "no json here" } }),
		]);

		expect(record).not.toHaveBeenCalled();
	});

	it("should avoid parsing output when timing is disabled", () => {
		expect.assertions(1);

		const entry = { jestOutput: runnerOutput({ findJest: 0.2 }) };
		const readJestOutput = vi.spyOn(entry, "jestOutput", "get");

		recordLuauTimingSpans(fromPartial<TimingCollector>({ enabled: false }), [
			fromPartial<RawBackendEntry>({ entry }),
		]);

		expect(readJestOutput).not.toHaveBeenCalled();
	});
});

describe(printLuauTiming, () => {
	it("should print rounded phases and their exact total", () => {
		expect.assertions(1);

		const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		printLuauTiming({ findJest: 0.0014, jestRunCLI: 0.0026 });

		expect(write.mock.calls.map(([message]) => message)).toStrictEqual([
			"[TIMING] findJest: 1ms\n",
			"[TIMING] jestRunCLI: 3ms\n",
			"[TIMING] total: 4ms\n",
		]);
	});
});
