import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import type { RunProgress } from "../progress/reporter.ts";
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

function createRecordingProgress() {
	const calls: Array<string> = [];
	const progress: RunProgress = {
		begin: (id, detail) => {
			calls.push(detail === undefined ? `begin:${id}` : `begin:${id}:${detail}`);
			return (closingDetail) => {
				calls.push(
					closingDetail === undefined ? `end:${id}` : `end:${id}:${closingDetail}`,
				);
			};
		},
		describe: (id, detail) => {
			calls.push(`describe:${id}:${detail}`);
		},
		finish: () => {
			calls.push("finish");
		},
		interleave: (write) => {
			calls.push("interleave");
			write();
		},
		note: (id, detail) => {
			calls.push(`note:${id}:${detail}`);
		},
		reveal: () => {
			calls.push("reveal");
		},
	};

	return { calls, progress };
}

describe(createTimingCollector, () => {
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
			"[TIMING] prepareCoverage: start",
			"[TIMING] prepareCoverage: 10ms",
			"[TIMING]   parse-ast: 6ms",
			"[TIMING]   (unmeasured): 4ms",
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
			"[TIMING] probe-insert: start",
			"[TIMING] probe-insert: 3ms",
			"[TIMING] probe-insert: start",
			"[TIMING] probe-insert: 7ms (×2)",
			"[TIMING] TOTAL (host): 7ms",
		]);
	});

	it("should report an async phase when it settles, before any flush", async () => {
		expect.assertions(2);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 12]),
			enabled: true,
			sink,
		});

		await collector.profileAsync("loadPackages", async () => {});

		expect(lines).toStrictEqual([
			"[TIMING] loadPackages: start",
			"[TIMING] loadPackages: 12ms",
		]);

		collector.flushTimingReport();

		expect(lines).toStrictEqual([
			"[TIMING] loadPackages: start",
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
			"[TIMING] runProjects: start",
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
			"[TIMING] synthesize: start",
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
			"[TIMING] synthesize: start",
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
			"[TIMING] synthesize: start\n[TIMING] synthesize: 4ms\n[TIMING] TOTAL (host): 4ms\n",
		);
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
			"[TIMING] backend.runTests: start",
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
			"[TIMING] backend.uploadMs: 7ms (×2)",
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
			"[TIMING] synthesize: start",
			expect.stringMatching(/^\[TIMING] synthesize: \d+ms$/),
			expect.stringMatching(/^\[TIMING] TOTAL \(host\): \d+ms$/),
		]);
	});

	it("should announce a top-level phase before it runs", () => {
		expect.assertions(2);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 5]),
			enabled: true,
			sink,
		});

		collector.profile("synthesize", () => {
			// The announcement is the only thing a run that hangs here writes.
			expect(lines).toStrictEqual(["[TIMING] synthesize: start"]);
		});

		expect(lines).toStrictEqual(["[TIMING] synthesize: start", "[TIMING] synthesize: 5ms"]);
	});

	it("should announce a top-level phase once per run of it", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 1, 2, 3, 4, 5]),
			enabled: true,
			sink,
		});

		collector.profile("prepareCoverage", () => {
			collector.profile("parse-ast", () => {});
			collector.profile("parse-ast", () => {});
		});

		// Nested spans never announce — one line per phase, not per file.
		expect(lines.filter((line) => line.endsWith(": start"))).toStrictEqual([
			"[TIMING] prepareCoverage: start",
		]);
	});

	it("should hold a nested span until its top-level phase closes", () => {
		expect.assertions(2);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 2, 8, 10]),
			enabled: true,
			sink,
		});

		collector.profile("prepareCoverage", () => {
			collector.profile("parse-ast", () => {});

			expect(lines).toStrictEqual(["[TIMING] prepareCoverage: start"]);
		});

		expect(lines).toStrictEqual([
			"[TIMING] prepareCoverage: start",
			"[TIMING] prepareCoverage: 10ms",
			"[TIMING]   parse-ast: 6ms",
			"[TIMING]   (unmeasured): 4ms",
		]);
	});

	it("should aggregate repeated nested spans into one counted line", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 1, 3, 3, 4, 10]),
			enabled: true,
			sink,
		});

		collector.profile("prepareCoverage", () => {
			collector.profile("parse-ast", () => {});
			collector.profile("parse-ast", () => {});
		});

		expect(lines).toStrictEqual([
			"[TIMING] prepareCoverage: start",
			"[TIMING] prepareCoverage: 10ms",
			"[TIMING]   parse-ast: 3ms (×2)",
			"[TIMING]   (unmeasured): 7ms",
		]);
	});

	it("should report unmeasured time at every depth that has children", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 1, 2, 3, 6, 20]),
			enabled: true,
			sink,
		});

		collector.profile("runProjects", () => {
			collector.profile("processResults", () => {
				collector.profile("buildSourceMapper", () => {});
			});
		});

		expect(lines).toStrictEqual([
			"[TIMING] runProjects: start",
			"[TIMING] runProjects: 20ms",
			"[TIMING]   processResults: 5ms",
			"[TIMING]     buildSourceMapper: 1ms",
			"[TIMING]     (unmeasured): 4ms",
			"[TIMING]   (unmeasured): 15ms",
		]);
	});

	it("should omit the unmeasured line when the children account for the phase", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 0, 10, 10]),
			enabled: true,
			sink,
		});

		collector.profile("prepareCoverage", () => {
			collector.profile("parse-ast", () => {});
		});

		expect(lines).toStrictEqual([
			"[TIMING] prepareCoverage: start",
			"[TIMING] prepareCoverage: 10ms",
			"[TIMING]   parse-ast: 10ms",
		]);
	});

	it("should hold a root-level record until the flush", () => {
		expect.assertions(2);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({ enabled: true, sink });

		collector.record("runTypecheck", 4);

		expect(lines).toStrictEqual([]);

		collector.flushTimingReport();

		expect(lines).toStrictEqual(["[TIMING] runTypecheck: 4ms", "[TIMING] TOTAL (host): 4ms"]);
	});

	it("should keep the span stack intact when the announcing sink throws", () => {
		expect.assertions(2);

		const sink = vi.fn<(line: string) => void>();
		sink.mockImplementationOnce(() => {
			throw new Error("sink boom");
		});

		const collector = createTimingCollector({
			clock: createScriptedClock([0, 1]),
			enabled: true,
			sink,
		});

		expect(() => {
			collector.profile("boom-phase", () => {});
		}).toThrow("sink boom");

		collector.profile("next-phase", () => {});

		// A stranded frame would swallow the second phase's own announcement
		// and its report, so those two lines are what prove the stack unwound.
		expect(sink.mock.calls.map((call) => call[0])).toStrictEqual([
			"[TIMING] boom-phase: start",
			"[TIMING] next-phase: start",
			"[TIMING] next-phase: 1ms",
		]);
	});

	it("should keep the span stack intact when the reporting sink throws", () => {
		expect.assertions(2);

		const sink = vi.fn<(line: string) => void>();
		// First call is the announcement; the phase's own report is second.
		sink.mockImplementationOnce(() => {});
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

		expect(sink.mock.calls.map((call) => call[0])).toStrictEqual([
			"[TIMING] boom-phase: start",
			"[TIMING] boom-phase: 1ms",
			"[TIMING] next-phase: start",
			"[TIMING] next-phase: 1ms",
		]);
	});

	it("should write nothing while disabled", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({ enabled: false, sink });

		collector.profile("synthesize", () => {});
		collector.record("backend.uploadMs", 4);

		expect(lines).toStrictEqual([]);
	});

	it("should open and close the stage a profiled phase stands for", () => {
		expect.assertions(1);

		const { calls, progress } = createRecordingProgress();
		const collector = createTimingCollector({ progress });

		collector.profile("prepareCoverage", () => {});

		expect(calls).toStrictEqual(["begin:instrument", "end:instrument"]);
	});

	it("should announce a stage from a span nested inside another phase", () => {
		expect.assertions(1);

		const { calls, progress } = createRecordingProgress();
		const collector = createTimingCollector({ progress });

		collector.profile("runProjects", () => {
			collector.profile("processResults", () => {});
		});

		expect(calls).toStrictEqual(["begin:results", "end:results"]);
	});

	it("should stay silent for a phase that stands for no stage", () => {
		expect.assertions(1);

		const { calls, progress } = createRecordingProgress();
		const collector = createTimingCollector({ progress });

		collector.profile("buildJobs", () => {});

		expect(calls).toStrictEqual([]);
	});

	it("should announce nothing for an async phase that stands for no stage", async () => {
		expect.assertions(2);

		const { calls, progress } = createRecordingProgress();
		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({ enabled: false, progress, sink });

		await collector.profileAsync("prepareDispatch", async () => {});
		collector.flushTimingReport();

		expect(calls).toStrictEqual([]);
		expect(lines).toStrictEqual([]);
	});

	it("should report a whole millisecond of unmeasured time", () => {
		expect.assertions(1);

		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({
			clock: createScriptedClock([0, 1, 3, 3]),
			enabled: true,
			sink,
		});

		// The parent spans 3ms and its child 2ms, leaving exactly 1ms
		// unaccounted — the smallest gap the report still names.
		collector.profile("prepareCoverage", () => {
			collector.profile("parse-ast", () => {});
		});

		expect(lines).toContain("[TIMING]   (unmeasured): 1ms");
	});

	it("should keep the timing report quiet while only progress is wanted", () => {
		expect.assertions(1);

		const { progress } = createRecordingProgress();
		const { lines, sink } = createCapturingSink();
		const collector = createTimingCollector({ enabled: false, progress, sink });

		collector.profile("prepareCoverage", () => {});
		collector.flushTimingReport();

		expect(lines).toStrictEqual([]);
	});
});
