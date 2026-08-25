import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { createTimingCollector } from "./orchestration-collector.ts";

function createCapturingSink() {
	const lines: Array<string> = [];
	return {
		lines,
		sink: (line: string) => {
			lines.push(line);
		},
	};
}

function createScriptedClock(times: Array<number>) {
	let index = 0;
	return {
		now: () => {
			const value = index < times.length ? times[index]! : times.at(-1)!;
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

		expect(lines).toStrictEqual([
			"[TIMING] synthesize: 5ms",
			"[TIMING] synthesize: 5ms",
			"[TIMING] TOTAL (host): 5ms",
		]);
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
			"[TIMING] prepareCoverage > parse-ast: 6ms",
			"[TIMING] prepareCoverage: 10ms",
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

		expect(lines).toStrictEqual([
			"[TIMING] probe-insert: 3ms",
			"[TIMING] probe-insert: 4ms",
			"[TIMING] probe-insert: 7ms",
			"[TIMING] TOTAL (host): 7ms",
		]);
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

		expect(lines).toStrictEqual([
			"[TIMING] loadPackages: 12ms",
			"[TIMING] loadPackages: 12ms",
			"[TIMING] TOTAL (host): 12ms",
		]);
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

		expect(lines).toStrictEqual([
			"[TIMING] runProjects: 9ms",
			"[TIMING] runProjects: 9ms",
			"[TIMING] TOTAL (host): 9ms",
		]);
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

		expect(lines).toStrictEqual([
			"[TIMING] synthesize: 5ms",
			"[TIMING] synthesize: 5ms",
			"[TIMING] TOTAL (host): 5ms",
		]);
	});

	it("should enable itself when the TIMING env var is present", () => {
		expect.assertions(1);

		vi.stubEnv("TIMING", "");

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({ clock: createScriptedClock([0, 4]), sink });

		collector.profile("synthesize", () => {});
		collector.flushTimingReport();

		expect(lines).toStrictEqual([
			"[TIMING] synthesize: 4ms",
			"[TIMING] synthesize: 4ms",
			"[TIMING] TOTAL (host): 4ms",
		]);
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
			"[TIMING] synthesize: 4ms\n[TIMING] synthesize: 4ms\n[TIMING] TOTAL (host): 4ms\n",
		);
	});

	it("should record a leaf span with a supplied elapsedMs", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({ enabled: true, sink });

		collector.record("backend.uploadMs", 1234);
		collector.flushTimingReport();

		expect(lines).toStrictEqual([
			"[TIMING] backend.uploadMs: 1234ms",
			"[TIMING] backend.uploadMs: 1234ms",
			"[TIMING] TOTAL (host): 1234ms",
		]);
	});

	it("should nest recorded spans under the currently-open profile frame", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 10]),
			enabled: true,
			sink,
		});

		collector.profile("backend.runTests", () => {
			collector.record("backend.uploadMs", 4);
			collector.record("backend.executionMs", 6);
		});
		collector.flushTimingReport();

		expect(lines).toStrictEqual([
			"[TIMING] backend.runTests > backend.uploadMs: 4ms",
			"[TIMING] backend.runTests > backend.executionMs: 6ms",
			"[TIMING] backend.runTests: 10ms",
			"[TIMING] backend.runTests: 10ms",
			"[TIMING]   backend.uploadMs: 4ms",
			"[TIMING]   backend.executionMs: 6ms",
			"[TIMING] TOTAL (host): 10ms",
		]);
	});

	it("should accumulate repeated record() calls with the same name", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({ enabled: true, sink });

		collector.record("backend.uploadMs", 3);
		collector.record("backend.uploadMs", 4);
		collector.flushTimingReport();

		expect(lines).toStrictEqual([
			"[TIMING] backend.uploadMs: 3ms",
			"[TIMING] backend.uploadMs: 4ms",
			"[TIMING] backend.uploadMs: 7ms",
			"[TIMING] TOTAL (host): 7ms",
		]);
	});

	it("should be a no-op when record() is called on a disabled collector", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({ enabled: false, sink });

		collector.record("backend.uploadMs", 42);
		collector.flushTimingReport();

		expect(lines).toStrictEqual([]);
	});

	it("should expose enabled true when constructed with enabled: true", () => {
		expect.assertions(1);

		const collector = createTimingCollector({ enabled: true });

		expect(collector.enabled).toBeTrue();
	});

	it("should expose enabled false when constructed with enabled: false", () => {
		expect.assertions(1);

		const collector = createTimingCollector({ enabled: false });

		expect(collector.enabled).toBeFalse();
	});

	it("should expose enabled true when the TIMING env var is present", () => {
		expect.assertions(1);

		vi.stubEnv("TIMING", "");

		const collector = createTimingCollector();

		expect(collector.enabled).toBeTrue();
	});

	it("should expose enabled false when the TIMING env var is absent", () => {
		expect.assertions(1);

		vi.stubEnv("TIMING", undefined);

		const collector = createTimingCollector();

		expect(collector.enabled).toBeFalse();
	});

	it("should use a real clock by default", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({ enabled: true, sink });

		collector.profile("synthesize", () => {});
		collector.flushTimingReport();

		expect(lines).toStrictEqual([
			expect.stringMatching(/^\[TIMING] synthesize: \d+ms$/),
			expect.stringMatching(/^\[TIMING] synthesize: \d+ms$/),
			expect.stringMatching(/^\[TIMING] TOTAL \(host\): \d+ms$/),
		]);
	});

	it("should stream a phase line the moment the phase completes", () => {
		expect.assertions(2);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 5]),
			enabled: true,
			sink,
		});

		collector.profile("synthesize", () => {});

		expect(lines).toStrictEqual(["[TIMING] synthesize: 5ms"]);

		collector.flushTimingReport();

		expect(lines).toStrictEqual([
			"[TIMING] synthesize: 5ms",
			"[TIMING] synthesize: 5ms",
			"[TIMING] TOTAL (host): 5ms",
		]);
	});

	it("should stream a nested span under its ancestor path", () => {
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

		expect(lines).toStrictEqual([
			"[TIMING] prepareCoverage > parse-ast: 6ms",
			"[TIMING] prepareCoverage: 10ms",
		]);
	});

	it("should stream each run of a repeated span separately", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 3, 3, 7]),
			enabled: true,
			sink,
		});

		collector.profile("probe-insert", () => {});
		collector.profile("probe-insert", () => {});

		expect(lines).toStrictEqual(["[TIMING] probe-insert: 3ms", "[TIMING] probe-insert: 4ms"]);
	});

	it("should stream an async phase when it settles", async () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 12]),
			enabled: true,
			sink,
		});

		await collector.profileAsync("loadPackages", async () => {});

		expect(lines).toStrictEqual(["[TIMING] loadPackages: 12ms"]);
	});

	it("should stream a recorded span under the open frame", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 10]),
			enabled: true,
			sink,
		});

		collector.profile("backend.runTests", () => {
			collector.record("backend.uploadMs", 4);
		});

		expect(lines).toStrictEqual([
			"[TIMING] backend.runTests > backend.uploadMs: 4ms",
			"[TIMING] backend.runTests: 10ms",
		]);
	});

	it("should keep the span stack intact when the stream sink throws", () => {
		expect.assertions(2);

		const sink = vi.fn<(line: string) => void>();
		sink.mockImplementationOnce(() => {
			throw new Error("sink boom");
		});

		const collector = createTimingCollector({
			clock: createScriptedClock([0, 1, 2, 3]),
			enabled: true,
			sink,
		});

		expect(() => {
			collector.profile("boom-phase", () => {});
		}).toThrow("sink boom");

		collector.profile("next-phase", () => {});

		// A stranded frame would stream "boom-phase > next-phase", so the
		// second line is what proves the stack unwound.
		expect(sink.mock.calls.map((call) => call[0])).toStrictEqual([
			"[TIMING] boom-phase: 1ms",
			"[TIMING] next-phase: 1ms",
		]);
	});

	it("should stream nothing while disabled", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({ enabled: false, sink });

		collector.profile("synthesize", () => {});
		collector.record("backend.uploadMs", 4);

		expect(lines).toStrictEqual([]);
	});
});
