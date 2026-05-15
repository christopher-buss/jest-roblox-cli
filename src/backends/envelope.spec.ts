import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/schema.ts";
import { LuauScriptError } from "../reporter/parser.ts";
import { buildProjectResult, parseEnvelope } from "./envelope.ts";
import type { EnvelopeEntry, ProjectJob } from "./interface.ts";

function successJest(overrides: Record<string, unknown> = {}): string {
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

function captureThrown(action: () => void): unknown {
	try {
		action();
	} catch (err) {
		return err;
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

	it("should rewrap a non-envelope-shaped payload as a length-1 entries array containing the raw jestOutput", () => {
		expect.assertions(1);

		const legacyPayload = JSON.stringify({ err: "boom", success: false });

		const result = parseEnvelope(legacyPayload);

		expect(result).toStrictEqual([{ jestOutput: legacyPayload }]);
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
			entry({ jestOutput: successJest({ _setup: 1.2345 }) }),
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
					_coverage: { "src/foo.luau": { s: { 1: 5 } } },
					_snapshotWrites: { "snapshots/foo.snap": "snapshot-content" },
					_timing: { setup: 0.5, total: 1.25 },
				}),
			}),
			job("alpha"),
			undefined,
		);

		expect(result.coverageData).toStrictEqual({
			"src/foo.luau": { b: undefined, f: undefined, s: { "1": 5 } },
		});
		expect(result.luauTiming).toStrictEqual({ setup: 0.5, total: 1.25 });
		expect(result.snapshotWrites).toStrictEqual({
			"snapshots/foo.snap": "snapshot-content",
		});
	});

	it("should attach the resolved gameOutput to LuauScriptError when parseJestOutput throws it", () => {
		expect.assertions(3);

		const errorPayload = JSON.stringify({ err: "boom", success: false });

		const thrown = captureThrown(() => {
			buildProjectResult(
				entry({ jestOutput: errorPayload }),
				job("alpha"),
				"fallback-output",
			);
		});

		expect(thrown).toBeInstanceOf(LuauScriptError);
		expect((thrown as Error).message).toBe("boom");
		expect((thrown as LuauScriptError).gameOutput).toBe("fallback-output");
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
