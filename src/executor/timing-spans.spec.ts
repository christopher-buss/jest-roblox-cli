import { fromPartial } from "@total-typescript/shoehorn";

import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import type { RawBackendEntry } from "../backends/interface.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import { printLuauTiming, recordLuauTimingSpans } from "./timing-spans.ts";

type ExtractLuauTimingFromOutput =
	(typeof import("../reporter/parser.ts"))["extractLuauTimingFromOutput"];

const extractLuauTimingFromOutput = vi.hoisted(() => vi.fn<ExtractLuauTimingFromOutput>());

vi.mock(import("../reporter/parser.ts"), () => ({ extractLuauTimingFromOutput }));

describe(recordLuauTimingSpans, () => {
	it("should record every Luau phase except its redundant total", () => {
		expect.assertions(2);

		extractLuauTimingFromOutput.mockReturnValue({ findJest: 0.2, jestRunCLI: 0.3, total: 0.5 });
		const record = vi.fn<TimingCollector["record"]>();
		const timing = fromPartial<TimingCollector>({ enabled: true, record });
		const rawResults = [
			fromPartial<RawBackendEntry>({ entry: { jestOutput: "runner output" } }),
		];

		recordLuauTimingSpans(timing, rawResults);

		expect(extractLuauTimingFromOutput).toHaveBeenCalledExactlyOnceWith("runner output");
		expect(record.mock.calls).toStrictEqual([
			["luau.findJest", 200],
			["luau.jestRunCLI", 300],
		]);
	});

	it("should avoid parsing output when timing is disabled", () => {
		expect.assertions(1);

		recordLuauTimingSpans(fromPartial<TimingCollector>({ enabled: false }), [
			fromPartial<RawBackendEntry>({ entry: { jestOutput: "runner output" } }),
		]);

		expect(extractLuauTimingFromOutput).not.toHaveBeenCalled();
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
