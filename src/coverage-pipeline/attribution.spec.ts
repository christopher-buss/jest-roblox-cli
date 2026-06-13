import { describe, expect, it } from "vitest";

import { applyAttribution, harvestAttribution, mergeAttribution } from "./attribution.ts";
import type { CoverageManifest } from "./manifest.ts";
import { MANIFEST_VERSION } from "./manifest.ts";

function exampleManifest(): CoverageManifest {
	return {
		buildId: "11111111-1111-1111-1111-111111111111",
		files: {
			"out/m.luau": {
				key: "out/m.luau",
				coverageMapPath: "out/m.luau.cov-map.json",
				instrumentedLuauPath: "out/m.luau",
				originalLuauPath: "out/m.luau",
				sourceHash: "abc",
				sourceMapPath: "out/m.luau.map",
				statementCount: 3,
			},
		},
		generatedAt: "2026-06-09T00:00:00.000Z",
		instrumenterVersion: 2,
		luauRoots: ["out"],
		nonInstrumentedFiles: {},
		shadowDir: ".jest-roblox/coverage",
		version: MANIFEST_VERSION,
	};
}

describe(harvestAttribution, () => {
	it("should attribute a covered statement to the single test that hit it", () => {
		expect.assertions(2);

		const result = harvestAttribution(
			[
				{
					delta: { "out/m.luau": { s: [1] } },
					testCaseId: "adds",
					testFilePath: "out/m.spec.luau",
				},
			],
			() => {
				return "hash-a";
			},
		);

		expect(result.tests).toStrictEqual([
			{
				testCaseId: "adds",
				testFilePath: "out/m.spec.luau",
				testFileSourceHash: "hash-a",
				testId: "out/m.spec.luau::adds",
			},
		]);
		expect(result.coveringTestIds).toStrictEqual({
			"out/m.luau": { "1": ["out/m.spec.luau::adds"] },
		});
	});

	it("should attribute every statement a multi-statement test covered", () => {
		expect.assertions(1);

		const result = harvestAttribution(
			[
				{
					delta: { "out/m.luau": { s: [1, 3] } },
					testCaseId: "adds",
					testFilePath: "out/m.spec.luau",
				},
			],
			() => {
				return "hash-a";
			},
		);

		expect(result.coveringTestIds).toStrictEqual({
			"out/m.luau": {
				"1": ["out/m.spec.luau::adds"],
				"3": ["out/m.spec.luau::adds"],
			},
		});
	});

	it("should list both tests that overlap on one statement", () => {
		expect.assertions(2);

		const result = harvestAttribution(
			[
				{
					delta: { "out/m.luau": { s: [1] } },
					testCaseId: "adds",
					testFilePath: "out/m.spec.luau",
				},
				{
					delta: { "out/m.luau": { s: [1, 2] } },
					testCaseId: "subtracts",
					testFilePath: "out/m.spec.luau",
				},
			],
			() => {
				return "hash-a";
			},
		);

		expect(result.tests).toHaveLength(2);
		expect(result.coveringTestIds).toStrictEqual({
			"out/m.luau": {
				"1": ["out/m.spec.luau::adds", "out/m.spec.luau::subtracts"],
				"2": ["out/m.spec.luau::subtracts"],
			},
		});
	});

	it("should drop a test that covered no statements", () => {
		expect.assertions(2);

		const result = harvestAttribution(
			[
				{ delta: {}, testCaseId: "covers nothing", testFilePath: "out/m.spec.luau" },
				{
					delta: { "out/m.luau": { s: [] } },
					testCaseId: "covers a file with no statements",
					testFilePath: "out/m.spec.luau",
				},
			],
			() => {
				return "hash-a";
			},
		);

		expect(result.tests).toStrictEqual([]);
		expect(result.coveringTestIds).toStrictEqual({});
	});

	it("should record the partial coverage of a test that errored mid-run", () => {
		expect.assertions(2);

		// The runner diffs on failure too, so a test that threw after covering
		// statement 1 (but before reaching 2 and 3) still attributes statement 1.
		const result = harvestAttribution(
			[
				{
					delta: { "out/m.luau": { s: [1] } },
					testCaseId: "throws after the first assertion",
					testFilePath: "out/m.spec.luau",
				},
			],
			() => {
				return "hash-a";
			},
		);

		expect(result.tests).toHaveLength(1);
		expect(result.coveringTestIds["out/m.luau"]).toStrictEqual({
			"1": ["out/m.spec.luau::throws after the first assertion"],
		});
	});

	it("should record an empty source hash when the test file cannot be resolved", () => {
		expect.assertions(1);

		const result = harvestAttribution(
			[
				{
					delta: { "out/m.luau": { s: [1] } },
					testCaseId: "adds",
					testFilePath: "out/m.spec.luau",
				},
			],
			() => {},
		);

		expect(result.tests[0]!.testFileSourceHash).toBe("");
	});
});

describe(applyAttribution, () => {
	it("should write tests[] and distribute coveringTestIds into file records", () => {
		expect.assertions(2);

		const result = applyAttribution(exampleManifest(), {
			coveringTestIds: { "out/m.luau": { "1": ["t1"], "2": ["t1", "t2"] } },
			tests: [
				{
					testCaseId: "adds",
					testFilePath: "out/m.spec.luau",
					testFileSourceHash: "h",
					testId: "t1",
				},
			],
		});

		expect(result.tests).toStrictEqual([
			{
				testCaseId: "adds",
				testFilePath: "out/m.spec.luau",
				testFileSourceHash: "h",
				testId: "t1",
			},
		]);

		expect(result.files["out/m.luau"]!.coveringTestIds).toStrictEqual({
			"1": ["t1"],
			"2": ["t1", "t2"],
		});
	});

	it("should ignore covering attribution for files absent from the manifest", () => {
		expect.assertions(1);

		const result = applyAttribution(exampleManifest(), {
			coveringTestIds: { "out/ghost.luau": { "1": ["t1"] } },
			tests: [],
		});

		expect(result.files["out/ghost.luau"]).toBeUndefined();
	});
});

describe(mergeAttribution, () => {
	it("should concatenate tests and union per-statement covering ids", () => {
		expect.assertions(1);

		const merged = mergeAttribution(
			{
				coveringTestIds: { "out/m.luau": { "1": ["a"] } },
				tests: [
					{
						testCaseId: "a",
						testFilePath: "out/a.spec.luau",
						testFileSourceHash: "h",
						testId: "a",
					},
				],
			},
			{
				coveringTestIds: { "out/m.luau": { "1": ["b"], "2": ["c"] } },
				tests: [
					{
						testCaseId: "b",
						testFilePath: "out/b.spec.luau",
						testFileSourceHash: "h",
						testId: "b",
					},
				],
			},
		);

		expect(merged).toStrictEqual({
			coveringTestIds: { "out/m.luau": { "1": ["a", "b"], "2": ["c"] } },
			tests: [
				{
					testCaseId: "a",
					testFilePath: "out/a.spec.luau",
					testFileSourceHash: "h",
					testId: "a",
				},
				{
					testCaseId: "b",
					testFilePath: "out/b.spec.luau",
					testFileSourceHash: "h",
					testId: "b",
				},
			],
		});
	});
});
