import { assert, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { RawCoverageData } from "../coverage-pipeline/types.ts";
import { LuauScriptError, type SnapshotWrites } from "../reporter/parser.ts";
import type { JestResult } from "../types/jest-result.ts";
import {
	buildProjectResult,
	decodeEnvelope,
	isEnvelopeDeferred,
	parseEnvelope,
} from "./envelope.ts";
import type { EnvelopeEntry, ProjectJob } from "./interface.ts";

interface RunnerFieldOverrides {
	coverage?: RawCoverageData;
	setup?: number;
	snapshotWrites?: SnapshotWrites;
	timing?: Record<string, number>;
}

type JestPayloadOverrides = Partial<JestResult> & { runner?: RunnerFieldOverrides };

function successJest(overrides: JestPayloadOverrides = {}): string {
	return JSON.stringify({
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: 0,
		success: true,
		testResults: [],
		...overrides,
	});
}

function job(displayName: string, overrides: Partial<ProjectJob> = {}): ProjectJob {
	return {
		config: DEFAULT_CONFIG,
		displayColor: `${displayName}-color`,
		displayName,
		testFiles: [`${displayName}/test.spec.ts`],
		...overrides,
	};
}

function entry(overrides: Partial<EnvelopeEntry> = {}): EnvelopeEntry {
	return { jestOutput: successJest(), ...overrides };
}

function captureThrown(action: () => void): Error {
	try {
		action();
	} catch (err) {
		if (err instanceof Error) {
			return err;
		}

		throw new TypeError(`Expected the action to throw an Error, got ${String(err)}`);
	}

	throw new Error("Expected the action to throw");
}

describe(parseEnvelope, () => {
	it("should return the entries array for a valid single-entry envelope", () => {
		expect.assertions(1);

		const envelope = JSON.stringify({ entries: [{ jestOutput: '{"some":"payload"}' }] });

		const result = parseEnvelope(envelope);

		expect(result).toStrictEqual([{ jestOutput: '{"some":"payload"}' }]);
	});

	it("should return all entries for a valid multi-entry envelope", () => {
		expect.assertions(1);

		const envelope = JSON.stringify({
			entries: [
				{ elapsedMs: 12, jestOutput: '{"a":1}' },
				{ elapsedMs: 34, gameOutput: "hello", jestOutput: '{"b":2}' },
			],
		});

		const result = parseEnvelope(envelope);

		expect(result).toStrictEqual([
			{ elapsedMs: 12, jestOutput: '{"a":1}' },
			{ elapsedMs: 34, gameOutput: "hello", jestOutput: '{"b":2}' },
		]);
	});

	it("should preserve optional pkg and project fields on entries", () => {
		expect.assertions(1);

		const envelope = JSON.stringify({
			entries: [
				{ jestOutput: '{"a":1}', pkg: "@halcyon/foo", project: "client" },
				{ jestOutput: '{"b":2}', pkg: "@halcyon/bar" },
			],
		});

		const result = parseEnvelope(envelope);

		expect(result).toStrictEqual([
			{ jestOutput: '{"a":1}', pkg: "@halcyon/foo", project: "client" },
			{ jestOutput: '{"b":2}', pkg: "@halcyon/bar" },
		]);
	});

	it("should preserve the optional snapshotWrites field on entries", () => {
		expect.assertions(1);

		const envelope = JSON.stringify({
			entries: [
				{
					jestOutput: '{"a":1}',
					pkg: "@halcyon/foo",
					snapshotWrites: {
						"ReplicatedStorage/Pkg/__snapshots__/foo.spec.snap": "foo content",
					},
				},
			],
		});

		const result = parseEnvelope(envelope);

		expect(result).toStrictEqual([
			{
				jestOutput: '{"a":1}',
				pkg: "@halcyon/foo",
				snapshotWrites: {
					"ReplicatedStorage/Pkg/__snapshots__/foo.spec.snap": "foo content",
				},
			},
		]);
	});

	it("should rewrap a bare non-error jest result as a length-1 entries array containing the raw jestOutput", () => {
		expect.assertions(1);

		const barePayload = successJest();

		const result = parseEnvelope(barePayload);

		expect(result).toStrictEqual([{ jestOutput: barePayload }]);
	});

	it("should surface a top-level whole-run error as a clean LuauScriptError", () => {
		// A {success:false, err} payload is the runtime crashing before it emits
		// any per-job entry. Surfacing it here (instead of rewrapping) keeps the
		// caller's entries-vs-jobs count guard from masking the real cause.
		expect.assertions(1);

		const errorPayload = JSON.stringify({ err: "boom", success: false });

		const thrown = captureThrown(() => {
			parseEnvelope(errorPayload);
		});

		assert(thrown instanceof LuauScriptError);

		expect(thrown.message).toBe("boom");
	});

	it("should extract the leaf cause from a promise-trace whole-run error", () => {
		expect.assertions(1);

		const promiseTrace = [
			"-- Promise.Error(ExecutionError) --",
			"",
			"...Rejected because it was chained to the following Promise, which encountered an error:",
			"",
			"ReplicatedStorage.rbxts_include.RobloxShared.nodeUtils:25: LoadString must be enabled",
		].join("\n");
		const errorPayload = JSON.stringify({ err: promiseTrace, success: false });

		const thrown = captureThrown(() => {
			parseEnvelope(errorPayload);
		});

		assert(thrown instanceof LuauScriptError);

		expect(thrown.message).toBe("LoadString must be enabled");
	});

	it("should propagate JSON.parse errors when the input is not valid JSON", () => {
		expect.assertions(1);

		expect(() => parseEnvelope("{not valid json")).toThrow(SyntaxError);
	});
});

describe(buildProjectResult, () => {
	it("should map a successful entry to ProjectBackendResult fields populated from parseJestOutput", () => {
		expect.assertions(1);

		const result = buildProjectResult(
			entry({ elapsedMs: 42, jestOutput: successJest({ numPassedTests: 3 }) }),
			job("alpha"),
			undefined,
		);

		expect(result).toMatchObject({
			displayColor: "alpha-color",
			displayName: "alpha",
			elapsedMs: 42,
			result: {
				numFailedTests: 0,
				numPassedTests: 3,
				numTotalTests: 1,
				success: true,
			},
		});
	});

	it("should use the per-entry gameOutput when present", () => {
		expect.assertions(1);

		const result = buildProjectResult(
			entry({ gameOutput: "per-entry-output" }),
			job("alpha"),
			"fallback-output",
		);

		expect(result.gameOutput).toBe("per-entry-output");
	});

	it("should fall back to fallbackGameOutput when the entry has no gameOutput", () => {
		expect.assertions(1);

		const result = buildProjectResult(entry(), job("alpha"), "fallback-output");

		expect(result.gameOutput).toBe("fallback-output");
	});

	it("should default elapsedMs to 0 when the entry has no elapsedMs", () => {
		expect.assertions(1);

		const result = buildProjectResult(entry(), job("alpha"), undefined);

		expect(result.elapsedMs).toBe(0);
	});

	it("should pass through job.displayColor and job.displayName", () => {
		expect.assertions(2);

		const result = buildProjectResult(
			entry(),
			job("alpha", { displayColor: "custom-color" }),
			undefined,
		);

		expect(result.displayName).toBe("alpha");
		expect(result.displayColor).toBe("custom-color");
	});

	it("should convert setupSeconds to setupMs by multiplying by 1000 and rounding", () => {
		expect.assertions(1);

		const result = buildProjectResult(
			entry({ jestOutput: successJest({ runner: { setup: 1.2345 } }) }),
			job("alpha"),
			undefined,
		);

		expect(result.setupMs).toBe(1235);
	});

	it("should leave setupMs undefined when parseJestOutput returns no setupSeconds", () => {
		expect.assertions(1);

		const result = buildProjectResult(entry(), job("alpha"), undefined);

		expect(result.setupMs).toBeUndefined();
	});

	it("should pass through coverageData, luauTiming, and snapshotWrites from parseJestOutput", () => {
		expect.assertions(3);

		const result = buildProjectResult(
			entry({
				jestOutput: successJest({
					runner: {
						coverage: { "src/foo.luau": { s: { 1: 5 } } },
						snapshotWrites: { "snapshots/foo.snap": "snapshot-content" },
						timing: { setup: 0.5, total: 1.25 },
					},
				}),
			}),
			job("alpha"),
			undefined,
		);

		expect(result.coverageData).toStrictEqual({
			"src/foo.luau": { s: { "1": 5 } },
		});
		expect(result.luauTiming).toStrictEqual({ setup: 0.5, total: 1.25 });
		expect(result.snapshotWrites).toStrictEqual({
			"snapshots/foo.snap": "snapshot-content",
		});
	});

	it("should prefer entry-level snapshotWrites over the parsed-from-jestOutput value", () => {
		expect.assertions(1);

		const result = buildProjectResult(
			entry({
				jestOutput: successJest({
					runner: {
						snapshotWrites: { "stale/inner.snap": "ignored" },
					},
				}),
				snapshotWrites: { "fresh/outer.snap": "wins" },
			}),
			job("alpha"),
			undefined,
		);

		expect(result.snapshotWrites).toStrictEqual({ "fresh/outer.snap": "wins" });
	});

	it("should fall back to parsed snapshotWrites when entry-level is an empty object", () => {
		expect.assertions(1);

		const result = buildProjectResult(
			entry({
				jestOutput: successJest({
					runner: {
						snapshotWrites: { "legacy.snap": "kept" },
					},
				}),
				snapshotWrites: {},
			}),
			job("alpha"),
			undefined,
		);

		expect(result.snapshotWrites).toStrictEqual({ "legacy.snap": "kept" });
	});

	it("should attach the resolved gameOutput to LuauScriptError when parseJestOutput throws it", () => {
		expect.assertions(2);

		const errorPayload = JSON.stringify({ err: "boom", success: false });

		const thrown = captureThrown(() => {
			buildProjectResult(
				entry({ jestOutput: errorPayload }),
				job("alpha"),
				"fallback-output",
			);
		});

		assert(thrown instanceof LuauScriptError);

		expect(thrown.message).toBe("boom");
		expect(thrown.gameOutput).toBe("fallback-output");
	});

	it("should prefer per-entry gameOutput over the backend fallback on the failure path", () => {
		// Regression: luau/staging/entry.luau now installs an interceptWriteable
		// around runEntry so per-pkg failures carry captured stdout
		// (e.g. "No tests found, exiting with code 1") in `entry.gameOutput`.
		// buildProjectResult must hand that to LuauScriptError.gameOutput so
		// the CLI banner's "Test Run Failed" branch can render it as the body.
		expect.assertions(1);

		const capturedStdout = JSON.stringify([
			{
				message: "No tests found, exiting with code 1",
				messageType: 0,
				timestamp: 0.001,
			},
		]);
		const errorPayload = JSON.stringify({ err: "Exited with code: 1", success: false });

		const thrown = captureThrown(() => {
			buildProjectResult(
				entry({ gameOutput: capturedStdout, jestOutput: errorPayload }),
				job("alpha"),
				"fallback-not-used",
			);
		});

		assert(thrown instanceof LuauScriptError);

		expect(thrown.gameOutput).toBe(capturedStdout);
	});

	it("should extract trailing cause when entry encodes err as a Promise-trace string", () => {
		// Regression: workspace materializer (luau/staging/entry.luau) encodes
		// per-package failures as { success: false, err: tostring(promiseError)
		// }. buildProjectResult must surface the leaf cause and attach gameOutput
		// so the CLI banner renders "Test Run Failed" + captured stdout instead
		// of the multi-frame Promise.Error blob.
		expect.assertions(2);

		const promiseTrace = [
			"-- Promise.Error(ExecutionError) --",
			"",
			"...Rejected because it was chained to the following Promise, which encountered an error:",
			"",
			"ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.RobloxShared.nodeUtils:25: Exited with code: 1",
		].join("\n");

		const errorPayload = JSON.stringify({ err: promiseTrace, success: false });

		const thrown = captureThrown(() => {
			buildProjectResult(entry({ jestOutput: errorPayload }), job("alpha"), "No tests found");
		});

		assert(thrown instanceof LuauScriptError);

		expect(thrown.message).toBe("Exited with code: 1");
		expect(thrown.gameOutput).toBe("No tests found");
	});

	it("should propagate non-LuauScriptError errors from parseJestOutput unchanged", () => {
		expect.assertions(2);

		const thrown = captureThrown(() => {
			buildProjectResult(entry({ jestOutput: "{}" }), job("alpha"), "fallback-output");
		});

		expect(thrown).toBeInstanceOf(Error);
		expect(thrown).not.toBeInstanceOf(LuauScriptError);
	});
});

describe(decodeEnvelope, () => {
	it("should report a task that stopped on a failing package", () => {
		expect.assertions(1);

		const jestOutput = JSON.stringify({
			bailed: true,
			entries: [{ jestOutput: successJest(), pkg: "alpha" }],
		});

		expect(decodeEnvelope(jestOutput).bailed).toBeTrue();
	});

	it("should report a task that ran to the end", () => {
		expect.assertions(1);

		const jestOutput = JSON.stringify({
			bailed: false,
			entries: [{ jestOutput: successJest(), pkg: "alpha" }],
		});

		expect(decodeEnvelope(jestOutput).bailed).toBeFalse();
	});

	it("should treat a missing bailed flag as no bail", () => {
		expect.assertions(1);

		const jestOutput = JSON.stringify({
			entries: [{ jestOutput: successJest(), pkg: "alpha" }],
		});

		expect(decodeEnvelope(jestOutput).bailed).toBeFalse();
	});

	// A legacy bare Jest result decodes as one entry with neither stop flag —
	// the shape predates both, so it can only mean "ran everything".
	it("should report no stop flags for a non-envelope payload", () => {
		expect.assertions(2);

		const decoded = decodeEnvelope(successJest());

		expect(decoded.bailed).toBeFalse();
		expect(decoded.deferred).toBeFalse();
	});
});

describe("timed-out entries", () => {
	it("should mark the raised error as a timeout so the report can say so", () => {
		expect.assertions(2);

		const thrown = captureThrown(() => {
			buildProjectResult(
				entry({
					jestOutput: JSON.stringify({
						err: "Timed out after 60s, aborting tests",
						runner: { abandon: "timeout" },
						success: false,
					}),
				}),
				job("alpha"),
				undefined,
			);
		});

		assert(thrown instanceof LuauScriptError);

		expect(thrown.timedOut).toBeTrue();
		expect(thrown.message).toBe("Timed out after 60s, aborting tests");
	});

	it("should leave an ordinary script failure unmarked", () => {
		expect.assertions(1);

		const thrown = captureThrown(() => {
			buildProjectResult(
				entry({ jestOutput: JSON.stringify({ err: "boom", success: false }) }),
				job("alpha"),
				undefined,
			);
		});

		assert(thrown instanceof LuauScriptError);

		expect(thrown.timedOut).toBeUndefined();
	});
});

describe(isEnvelopeDeferred, () => {
	it("should report a task that stopped with queued work outstanding", () => {
		expect.assertions(1);

		const jestOutput = JSON.stringify({
			deferred: true,
			entries: [{ jestOutput: successJest(), pkg: "alpha" }],
		});

		expect(isEnvelopeDeferred(jestOutput)).toBeTrue();
	});

	it("should report a task that drained the queue", () => {
		expect.assertions(1);

		const jestOutput = JSON.stringify({
			deferred: false,
			entries: [{ jestOutput: successJest(), pkg: "alpha" }],
		});

		expect(isEnvelopeDeferred(jestOutput)).toBeFalse();
	});

	it("should treat a missing deferred flag as nothing outstanding", () => {
		expect.assertions(1);

		const jestOutput = JSON.stringify({
			entries: [{ jestOutput: successJest(), pkg: "alpha" }],
		});

		expect(isEnvelopeDeferred(jestOutput)).toBeFalse();
	});

	// The pool consults this while it is still deciding whether to launch more
	// work. Throwing there would be swallowed as a task error, so a broken
	// payload must read as "nothing outstanding" and leave the strict parse
	// after the pool settles to surface the real failure.
	it("should treat malformed output as nothing outstanding", () => {
		expect.assertions(2);

		expect(isEnvelopeDeferred("not json at all")).toBeFalse();
		expect(isEnvelopeDeferred(JSON.stringify({ err: "boom", success: false }))).toBeFalse();
	});
});
