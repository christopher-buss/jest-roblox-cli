import { fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import { MANIFEST_VERSION } from "#test/mocks/run-constants.ts";
import type { CliOptions, WorkspaceRunOptions } from "../config/schema.ts";
import type { aggregateWorkspaceCoverage } from "../coverage-pipeline/workspace-aggregate.ts";
import type { ExecuteResult } from "../executor.ts";
import type { WorkspaceProjectResult } from "../workspace-runner.ts";
import type { PackageCoverageSettings } from "../workspace/coverage-attach.ts";
import { buildWorkspaceResult, EMPTY_RESULT } from "./workspace-result.ts";

const MANIFEST = {
	buildId: "test-build-id",
	files: {},
	generatedAt: "x",
	instrumenterVersion: 2,
	luauRoots: [],
	nonInstrumentedFiles: {},
	shadowDir: "/shadow",
	version: MANIFEST_VERSION,
};

function makeExecuteResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
	return {
		exitCode: 0,
		output: "",
		result: {
			numFailedTests: 0,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: 0,
			success: true,
			testResults: [],
		},
		timing: { executionMs: 0, startTime: 0, testsMs: 0, totalMs: 0, uploadMs: 0 },
		...overrides,
	};
}

function coverageSettingsStub(): PackageCoverageSettings {
	return {
		coverageDirectory: "/ws/packages/foo/coverage",
		coverageReporters: ["text", "lcov"],
		rootDir: "/ws/packages/foo",
	};
}

function makeRunOptions(): WorkspaceRunOptions {
	return fromPartial({ color: true, formatters: ["default"], silent: false });
}

function build({
	aggregateCoverage = vi.fn<typeof aggregateWorkspaceCoverage>(() => []),
	cli = {},
	results,
}: {
	aggregateCoverage?: typeof aggregateWorkspaceCoverage;
	cli?: CliOptions;
	results: Array<WorkspaceProjectResult>;
}) {
	return buildWorkspaceResult({
		aggregateCoverage,
		cli,
		output: { results },
		runOptions: makeRunOptions(),
		workspaceRoot: "/repo",
	});
}

describe(buildWorkspaceResult, () => {
	it("should return the empty result when nothing ran", () => {
		expect.assertions(1);

		expect(build({ results: [] })).toBe(EMPTY_RESULT);
	});

	describe("coverage aggregation", () => {
		it("should feed each package's own coverage inputs into the aggregator", () => {
			expect.assertions(2);

			const aggregateCoverage = vi.fn<typeof aggregateWorkspaceCoverage>(() => {
				return [{ pkg: "@halcyon/foo", universe: { files: {} } }];
			});
			const result = build({
				aggregateCoverage,
				results: [
					{
						coverageManifest: MANIFEST,
						coverageSettings: {
							collectCoverageFrom: ["src/**/*.ts"],
							coverageDirectory: "/ws/packages/foo/coverage",
							coveragePathIgnorePatterns: ["**/node_modules/**"],
							coverageReporters: ["text"],
							rootDir: "/ws/packages/foo",
						},
						displayName: "@halcyon/foo",
						pkg: "@halcyon/foo",
						result: makeExecuteResult({
							coverageData: { "out/foo.luau": { s: { "1": 3 } } },
						}),
					},
				],
			});

			// The package's own globs reach the aggregator, along with the
			// rootDir they are written relative to, so the universe it builds
			// is the one both the report and the gate see.
			expect(aggregateCoverage).toHaveBeenCalledWith([
				expect.objectContaining({
					coverageData: { "out/foo.luau": { s: { "1": 3 } } },
					ignorePatterns: ["**/node_modules/**"],
					includePatterns: ["src/**/*.ts"],
					manifest: MANIFEST,
					pkg: "@halcyon/foo",
					rootDir: "/ws/packages/foo",
				}),
			]);
			expect(result.coveragePackages).toHaveLength(1);
		});

		it("should merge raw coverageData across same-pkg multi-project entries and skip pkgs without a manifest", () => {
			expect.assertions(3);

			const aggregateCoverage = vi.fn<typeof aggregateWorkspaceCoverage>(() => []);
			build({
				aggregateCoverage,
				results: [
					// Two projects under the same pkg — coverageData must MERGE
					// (each project runs Jest with its own _G.__jest_roblox_cov
					// reset, so the maps are disjoint).
					{
						coverageManifest: MANIFEST,
						coverageSettings: coverageSettingsStub(),
						displayName: "client",
						pkg: "@halcyon/foo",
						result: makeExecuteResult({
							coverageData: { "out/foo.luau": { s: { "1": 3 } } },
						}),
					},
					{
						coverageManifest: MANIFEST,
						coverageSettings: coverageSettingsStub(),
						displayName: "server",
						pkg: "@halcyon/foo",
						result: makeExecuteResult({
							coverageData: { "out/foo.luau": { s: { "1": 4 } } },
						}),
					},
					// Different pkg, no manifest — must be skipped.
					{
						displayName: "@halcyon/bar",
						pkg: "@halcyon/bar",
						result: makeExecuteResult(),
					},
				],
			});

			const aggregateCall = aggregateCoverage.mock.calls[0]![0];

			expect(aggregateCall).toHaveLength(1);
			expect(aggregateCall[0]!.pkg).toBe("@halcyon/foo");
			// 3 + 4 = 7 — both project hits summed.
			expect(aggregateCall[0]!.coverageData!["out/foo.luau"]!.s["1"]).toBe(7);
		});

		it("should expose an empty gate list when the aggregator returns no universes", () => {
			expect.assertions(1);

			// Coverage ran but no package produced data: `coveragePackages` is
			// present-but-empty, which is what tells the report layer to emit
			// nothing rather than an empty table.
			const result = build({
				results: [
					{
						coverageManifest: MANIFEST,
						coverageSettings: coverageSettingsStub(),
						displayName: "@halcyon/foo",
						pkg: "@halcyon/foo",
						result: makeExecuteResult(),
					},
				],
			});

			expect(result.coveragePackages).toStrictEqual([]);
		});

		it("should not aggregate when no runtime results carry a coverage manifest", () => {
			expect.assertions(2);

			const aggregateCoverage = vi.fn<typeof aggregateWorkspaceCoverage>(() => []);
			const result = build({
				aggregateCoverage,
				results: [
					{
						displayName: "@halcyon/foo",
						pkg: "@halcyon/foo",
						result: makeExecuteResult(),
					},
				],
			});

			expect(aggregateCoverage).not.toHaveBeenCalled();
			expect(result.coveragePackages).toBeUndefined();
		});

		it("should surface per-package coverage gates with each package's own threshold", () => {
			expect.assertions(3);

			const fooUniverse = { files: {} };
			const barUniverse = { files: {} };
			const result = build({
				aggregateCoverage: () => {
					return [
						{ pkg: "@halcyon/foo", universe: fooUniverse },
						{ pkg: "@halcyon/bar", universe: barUniverse },
					];
				},
				results: [
					{
						coverageManifest: MANIFEST,
						coverageSettings: {
							coverageDirectory: "/ws/packages/foo/coverage",
							coverageReporters: ["text"],
							coverageThreshold: { statements: 90 },
							rootDir: "/ws/packages/foo",
						},
						displayName: "@halcyon/foo",
						pkg: "@halcyon/foo",
						result: makeExecuteResult({
							coverageData: { "out/foo.luau": { s: { "1": 3 } } },
						}),
					},
					// No declared threshold — the gate entry must omit it, so
					// nothing gates the package.
					{
						coverageManifest: MANIFEST,
						coverageSettings: {
							coverageDirectory: "/ws/packages/bar/coverage",
							coverageReporters: ["lcov"],
							rootDir: "/ws/packages/bar",
						},
						displayName: "@halcyon/bar",
						pkg: "@halcyon/bar",
						result: makeExecuteResult({
							coverageData: { "out/bar.luau": { s: { "1": 1 } } },
						}),
					},
				],
			});

			expect(result.coveragePackages).toStrictEqual([
				{
					coverageDirectory: "/ws/packages/foo/coverage",
					coverageReporters: ["text"],
					coverageThreshold: { statements: 90 },
					pkg: "@halcyon/foo",
					universe: fooUniverse,
				},
				{
					coverageDirectory: "/ws/packages/bar/coverage",
					coverageReporters: ["lcov"],
					pkg: "@halcyon/bar",
					universe: barUniverse,
				},
			]);
			expect(result.coveragePackages![0]!.universe).toBe(fooUniverse);
			expect(result.coveragePackages![1]!.universe).toBe(barUniverse);
		});
	});

	describe("report options", () => {
		it("should carry the resolved presentation settings onto the result", () => {
			expect.assertions(1);

			const result = build({
				cli: { verbose: true },
				results: [{ displayName: "a", pkg: "a", result: makeExecuteResult() }],
			});

			expect(result.reportOptions).toStrictEqual({
				color: true,
				formatters: ["default"],
				rootDir: "/repo",
				silent: false,
				verbose: true,
			});
		});

		it("should report verbose false when the flag is absent", () => {
			expect.assertions(1);

			const result = build({
				results: [{ displayName: "a", pkg: "a", result: makeExecuteResult() }],
			});

			// `cli.verbose` is optional, so the report carries a real boolean
			// rather than the undefined the flag parser leaves behind.
			expect(result.reportOptions!.verbose).toBeFalse();
		});
	});
});
