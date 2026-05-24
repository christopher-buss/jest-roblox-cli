import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { createTimingCollector } from "./orchestration-collector.ts";

function createCapturingSink(): { lines: Array<string>; sink: (line: string) => void } {
	const lines: Array<string> = [];
	return {
		lines,
		sink: (line) => {
			lines.push(line);
		},
	};
}

function createScriptedClock(times: Array<number>): { now: () => number } {
	let index = 0;
	return {
		now: () => {
			const value = index < times.length ? times[index]! : times[times.length - 1]!;
			index += 1;
			return value;
		},
	};
}

describe(createTimingCollector, () => {
	it("should emit a phase line and a host total for a recorded span", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 5]),
			enabled: true,
			sink,
		});

		collector.profile("synthesize", () => {});
		collector.flushTimingReport();

		expect(lines).toStrictEqual(["[TIMING] synthesize: 5ms", "[TIMING] TOTAL (host): 5ms"]);
	});

	it("should indent nested spans and total only the top level", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 2, 8, 10]),
			enabled: true,
			sink,
		});

		collector.profile("prepareCoverage", () => {
			collector.profile("parse-ast", () => {});
		});
		collector.flushTimingReport();

		expect(lines).toStrictEqual([
			"[TIMING] prepareCoverage: 10ms",
			"[TIMING]   parse-ast: 6ms",
			"[TIMING] TOTAL (host): 10ms",
		]);
	});

	it("should merge sibling spans that share a name into one accumulated line", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 3, 3, 7]),
			enabled: true,
			sink,
		});

		collector.profile("probe-insert", () => {});
		collector.profile("probe-insert", () => {});
		collector.flushTimingReport();

		expect(lines).toStrictEqual(["[TIMING] probe-insert: 7ms", "[TIMING] TOTAL (host): 7ms"]);
	});

	it("should profile async phases and record resolution time", async () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 12]),
			enabled: true,
			sink,
		});

		await collector.profileAsync("loadPackages", async () => {});
		collector.flushTimingReport();

		expect(lines).toStrictEqual(["[TIMING] loadPackages: 12ms", "[TIMING] TOTAL (host): 12ms"]);
	});

	it("should record the elapsed time of a rejecting async phase and rethrow", async () => {
		expect.assertions(2);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 9]),
			enabled: true,
			sink,
		});

		await expect(
			collector.profileAsync("runProjects", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		collector.flushTimingReport();

		expect(lines).toStrictEqual(["[TIMING] runProjects: 9ms", "[TIMING] TOTAL (host): 9ms"]);
	});

	it("should run wrapped functions unchanged but write nothing when disabled", async () => {
		expect.assertions(3);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({ enabled: false, sink });

		expect(collector.profile("a", () => 42)).toBe(42);
		await expect(collector.profileAsync("b", async () => "ok")).resolves.toBe("ok");

		collector.flushTimingReport();

		expect(lines).toStrictEqual([]);
	});

	it("should write nothing when enabled but no spans were recorded", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({ enabled: true, sink });

		collector.flushTimingReport();

		expect(lines).toStrictEqual([]);
	});

	it("should not re-emit recorded spans on a second flush", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 5]),
			enabled: true,
			sink,
		});

		collector.profile("synthesize", () => {});
		collector.flushTimingReport();
		collector.flushTimingReport();

		expect(lines).toStrictEqual(["[TIMING] synthesize: 5ms", "[TIMING] TOTAL (host): 5ms"]);
	});

	it("should enable itself when the TIMING env var is present", () => {
		expect.assertions(1);

		vi.stubEnv("TIMING", "");

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({ clock: createScriptedClock([0, 4]), sink });

		collector.profile("synthesize", () => {});
		collector.flushTimingReport();

		expect(lines).toStrictEqual(["[TIMING] synthesize: 4ms", "[TIMING] TOTAL (host): 4ms"]);
	});

	it("should disable itself when the TIMING env var is absent", () => {
		expect.assertions(1);

		vi.stubEnv("TIMING", undefined);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({ clock: createScriptedClock([0, 4]), sink });

		collector.profile("synthesize", () => {});
		collector.flushTimingReport();

		expect(lines).toStrictEqual([]);
	});

	it("should write to process.stderr by default", () => {
		expect.assertions(1);

		const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 4]),
			enabled: true,
		});

		collector.profile("synthesize", () => {});
		collector.flushTimingReport();

		expect(write.mock.calls.map((call) => call[0]).join("")).toBe(
			"[TIMING] synthesize: 4ms\n[TIMING] TOTAL (host): 4ms\n",
		);
	});

	it("should use a real clock by default", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({ enabled: true, sink });

		collector.profile("synthesize", () => {});
		collector.flushTimingReport();

		expect(lines).toStrictEqual([
			expect.stringMatching(/^\[TIMING] synthesize: \d+ms$/),
			expect.stringMatching(/^\[TIMING] TOTAL \(host\): \d+ms$/),
		]);
	});
});
