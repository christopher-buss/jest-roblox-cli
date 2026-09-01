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

/**
 * A manifest as a warm run reads it: the shadow found `out/m.luau` unchanged
 * and carried the previous run's record forward verbatim, attribution included.
 */
function warmManifest(): CoverageManifest {
	const manifest = exampleManifest();
	manifest.files["out/m.luau"] = {
		...manifest.files["out/m.luau"]!,
		coveringTestIds: { "1": ["stale"], "2": ["stale"] },
		staticStatementIds: ["0"],
	};

	return manifest;
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
			{},
			() => "hash-a",
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
			{},
			() => "hash-a",
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
			{},
			() => "hash-a",
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
			{},
			() => "hash-a",
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
			{},
			() => "hash-a",
		);

		expect(result.tests).toHaveLength(1);
		expect(result.coveringTestIds["out/m.luau"]).toStrictEqual({
			"1": ["out/m.spec.luau::throws after the first assertion"],
		});
	});

	it("should mark statements hit at load but credited to no test as static", () => {
		expect.assertions(1);

		// Cumulative: statements 0, 1, 2 were all hit during the run. The test
		// credited only statement 2 to a window, so 0 and 1 ran at module load.
		const result = harvestAttribution(
			[
				{
					delta: { "out/m.luau": { s: [2] } },
					testCaseId: "adds",
					testFilePath: "out/m.spec.luau",
				},
			],
			{ "out/m.luau": { s: { "0": 1, "1": 1, "2": 1 } } },
			() => "hash-a",
		);

		expect(result.staticStatementIds).toStrictEqual({ "out/m.luau": ["0", "1"] });
	});

	it("should treat every hit in a file with no covering test as static", () => {
		expect.assertions(1);

		// No per-test deltas, so nothing is credited; statement 1 was never hit
		// (count 0) and stays out of the static set.
		const result = harvestAttribution(
			[],
			{ "out/m.luau": { s: { "0": 1, "1": 0 } } },
			() => "hash-a",
		);

		expect(result.staticStatementIds).toStrictEqual({ "out/m.luau": ["0"] });
	});

	it("should produce no static entry for a file whose every hit is credited", () => {
		expect.assertions(1);

		const result = harvestAttribution(
			[
				{
					delta: { "out/m.luau": { s: [1] } },
					testCaseId: "adds",
					testFilePath: "out/m.spec.luau",
				},
			],
			{ "out/m.luau": { s: { "1": 1 } } },
			() => "hash-a",
		);

		expect(result.staticStatementIds).toStrictEqual({});
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
			{},
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
			staticStatementIds: {},
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

	it("should distribute a static-statement set onto its file record", () => {
		expect.assertions(1);

		const result = applyAttribution(exampleManifest(), {
			coveringTestIds: {},
			staticStatementIds: { "out/m.luau": ["0", "1"] },
			tests: [],
		});

		expect(result.files["out/m.luau"]!.staticStatementIds).toStrictEqual(["0", "1"]);
	});

	it("should ignore covering and static attribution for files absent from the manifest", () => {
		expect.assertions(1);

		const result = applyAttribution(exampleManifest(), {
			coveringTestIds: { "out/ghost.luau": { "1": ["t1"] } },
			staticStatementIds: { "out/ghost.luau": ["0"] },
			tests: [],
		});

		expect(result.files["out/ghost.luau"]).toBeUndefined();
	});

	it("should drop a carried-forward coveringTestIds when this run has only static ids", () => {
		expect.assertions(3);

		// The detector-regression case: every statement of the file became
		// module-load code, so this harvest names it under static ids alone.
		const result = applyAttribution(warmManifest(), {
			coveringTestIds: {},
			staticStatementIds: { "out/m.luau": ["0", "1", "2"] },
			tests: [],
		});

		expect(result.files["out/m.luau"]!.coveringTestIds).toBeUndefined();
		expect(result.files["out/m.luau"]!.staticStatementIds).toStrictEqual(["0", "1", "2"]);
		expect(result.files["out/m.luau"]!.statementCount).toBe(3);
	});

	it("should drop a carried-forward staticStatementIds when this run has only covering ids", () => {
		expect.assertions(2);

		const result = applyAttribution(warmManifest(), {
			coveringTestIds: { "out/m.luau": { "0": ["t1"] } },
			staticStatementIds: {},
			tests: [],
		});

		expect(result.files["out/m.luau"]!.staticStatementIds).toBeUndefined();
		expect(result.files["out/m.luau"]!.coveringTestIds).toStrictEqual({ "0": ["t1"] });
	});

	it("should drop both carried-forward fields when this run attributes the file nothing", () => {
		expect.assertions(2);

		const result = applyAttribution(warmManifest(), {
			coveringTestIds: {},
			staticStatementIds: {},
			tests: [],
		});

		expect(result.files["out/m.luau"]!.coveringTestIds).toBeUndefined();
		expect(result.files["out/m.luau"]!.staticStatementIds).toBeUndefined();
	});
});

describe(mergeAttribution, () => {
	it("should concatenate tests and union per-statement covering ids", () => {
		expect.assertions(1);

		const merged = mergeAttribution(
			{
				coveringTestIds: { "out/m.luau": { "1": ["a"] } },
				staticStatementIds: {},
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
				staticStatementIds: {},
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
			staticStatementIds: {},
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

	it("should union static sets but drop any id credited in another project", () => {
		expect.assertions(1);

		// Statement 5 is static in A but credited to a test in B, so it is not
		// static across the merged run; 9 is static in both and credited nowhere.
		const merged = mergeAttribution(
			{
				coveringTestIds: { "out/m.luau": { "1": ["a"] } },
				staticStatementIds: { "out/m.luau": ["5", "9"] },
				tests: [],
			},
			{
				coveringTestIds: { "out/m.luau": { "5": ["b"] } },
				staticStatementIds: { "out/m.luau": ["9"] },
				tests: [],
			},
		);

		expect(merged.staticStatementIds).toStrictEqual({ "out/m.luau": ["9"] });
	});

	it("should union per-file static sets across projects, sorted and credited-filtered", () => {
		expect.assertions(1);

		const merged = mergeAttribution(
			{
				coveringTestIds: { "credited.luau": { "5": ["t"] } },
				staticStatementIds: { "credited.luau": ["5"], "only-a.luau": ["9", "2"] },
				tests: [],
			},
			{
				coveringTestIds: {},
				staticStatementIds: { "only-b.luau": ["3"] },
				tests: [],
			},
		);

		// only-a.luau: present only in A, sorted numerically; only-b.luau:
		// present only in B; credited.luau: its single static id is credited, so
		// it drops.
		expect(merged.staticStatementIds).toStrictEqual({
			"only-a.luau": ["2", "9"],
			"only-b.luau": ["3"],
		});
	});
});
