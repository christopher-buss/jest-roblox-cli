import { fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import { MANIFEST_VERSION } from "#test/mocks/run-constants.ts";
import type { WorkspaceRunOptions } from "../config/resolved-config.ts";
import type { CoverageMapper } from "../coverage-report/mapper.ts";
import type { ExecuteResult } from "../executor/executor-types.ts";
import type { CoverageUnitSettings } from "../results/coverage-unit.ts";
import type { WorkspaceProjectResult } from "./coverage-attach.ts";
import { buildWorkspaceResult } from "./result.ts";

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

function coverageSettingsStub(): CoverageUnitSettings {
	return {
		coverageDirectory: "/ws/packages/foo/coverage",
		coverageReporters: ["text", "lcov"],
		rootDir: "/ws/packages/foo",
	};
}

function makeRunOptions(overrides: Partial<WorkspaceRunOptions> = {}): WorkspaceRunOptions {
	return fromPartial({
		color: true,
		formatters: ["default"],
		showLuau: true,
		silent: false,
		verbose: false,
		...overrides,
		workspaceGameOutput: false,
		workspaceOutputFile: false,
	});
}

function build({
	mapCoverage = vi.fn<CoverageMapper>(() => ({ files: {} })),
	results,
	runOptions = makeRunOptions(),
}: {
	mapCoverage?: CoverageMapper;
	results: Array<WorkspaceProjectResult>;
	runOptions?: WorkspaceRunOptions;
}) {
	return buildWorkspaceResult({
		mapCoverage,
		output: { bailedPackages: [], coverageMs: 0, results, stagingMs: 0 },
		runOptions,
		workspaceRoot: "/repo",
	});
}

describe(buildWorkspaceResult, () => {
	describe("coverage aggregation", () => {
		it("should filter each package's coverage by its own globs against its rootDir", () => {
			expect.assertions(2);

			const covered = { path: "/ws/packages/foo/src/a.ts" };
			const outside = { path: "/ws/packages/foo/lib/b.ts" };
			const mapCoverage = vi.fn<CoverageMapper>(() => {
				return fromPartial({
					files: {
						"/ws/packages/foo/lib/b.ts": outside,
						"/ws/packages/foo/src/a.ts": covered,
					},
				});
			});
			const result = build({
				mapCoverage,
				results: [
					{
						coverageManifest: MANIFEST,
						coverageSettings: {
							collectCoverageFrom: ["src/**/*.ts"],
							coverageDirectory: "/ws/packages/foo/coverage",
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

			expect(mapCoverage).toHaveBeenCalledExactlyOnceWith({
				coverageData: { "out/foo.luau": { s: { "1": 3 } } },
				manifest: MANIFEST,
			});
			expect(Object.keys(result.coverage!.units[0]!.universe.files)).toStrictEqual([
				"/ws/packages/foo/src/a.ts",
			]);
		});

		it("should merge raw coverageData across same-pkg multi-project entries and skip pkgs without a manifest", () => {
			expect.assertions(2);

			const mapCoverage = vi.fn<CoverageMapper>(() => ({ files: {} }));
			build({
				mapCoverage,
				results: [
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
					{
						displayName: "@halcyon/bar",
						pkg: "@halcyon/bar",
						result: makeExecuteResult(),
					},
				],
			});

			expect(mapCoverage).toHaveBeenCalledOnce();
			expect(mapCoverage.mock.calls[0]![0].coverageData["out/foo.luau"]!.s["1"]).toBe(7);
		});

		it("should name a package whose coverage data came back empty", () => {
			expect.assertions(1);

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

			expect(result.coverage).toStrictEqual({
				notice: "Warning: coverage data was empty — the Rojo project may point at uninstrumented source (@halcyon/foo)",
				units: [],
			});
		});

		it("should join the notices of several packages one per line", () => {
			expect.assertions(1);

			const result = build({
				results: ["@halcyon/foo", "@halcyon/bar"].map((name) => {
					return {
						coverageManifest: MANIFEST,
						coverageSettings: coverageSettingsStub(),
						displayName: name,
						pkg: name,
						result: makeExecuteResult(),
					};
				}),
			});

			expect(result.coverage!.notice).toBe(
				[
					"Warning: coverage data was empty — the Rojo project may point at uninstrumented source (@halcyon/foo)",
					"Warning: coverage data was empty — the Rojo project may point at uninstrumented source (@halcyon/bar)",
				].join("\n"),
			);
		});

		it("should carry no notice when every package mapped", () => {
			expect.assertions(1);

			const result = build({
				results: ["@halcyon/foo", "@halcyon/bar"].map((name) => {
					return {
						coverageManifest: MANIFEST,
						coverageSettings: coverageSettingsStub(),
						displayName: name,
						pkg: name,
						result: makeExecuteResult({
							coverageData: { "out/a.luau": { s: { "1": 1 } } },
						}),
					};
				}),
			});

			expect(result.coverage).not.toHaveProperty("notice");
		});

		it("should not map when no runtime results carry a coverage manifest", () => {
			expect.assertions(2);

			const mapCoverage = vi.fn<CoverageMapper>();
			const result = build({
				mapCoverage,
				results: [
					{
						displayName: "@halcyon/foo",
						pkg: "@halcyon/foo",
						result: makeExecuteResult(),
					},
				],
			});

			expect(mapCoverage).not.toHaveBeenCalled();
			expect(result.coverage).toBeUndefined();
		});

		it("should surface per-package coverage gates with each package's own threshold", () => {
			expect.assertions(2);

			const result = build({
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

			expect(result.coverage!.units).toStrictEqual([
				{
					coverageDirectory: "/ws/packages/foo/coverage",
					coverageThreshold: { statements: 90 },
					label: "@halcyon/foo",
					reporters: ["text"],
					universe: { files: {} },
				},
				{
					coverageDirectory: "/ws/packages/bar/coverage",
					coverageThreshold: undefined,
					label: "@halcyon/bar",
					reporters: ["lcov"],
					universe: { files: {} },
				},
			]);
			expect(result.output!.collectCoverage).toBeTrue();
		});
	});

	describe("output settings", () => {
		it("should carry the resolved output settings onto the result", () => {
			expect.assertions(2);

			const result = build({
				results: [{ displayName: "a", pkg: "a", result: makeExecuteResult() }],
				runOptions: makeRunOptions({
					showLuau: false,
					slowTestThreshold: 2,
					verbose: true,
				}),
			});

			expect(result.output).toStrictEqual({
				collectCoverage: false,
				color: true,
				formatters: ["default"],
				gameOutput: undefined,
				outputFile: undefined,
				perUnitGameOutput: false,
				perUnitOutputFile: false,
				rootDir: "/repo",
				showLuau: false,
				silent: false,
				slowTestThreshold: 2,
				verbose: true,
			});
			expect(result.projectResults[0]!.unit).toStrictEqual({ pkg: "a", project: "a" });
		});

		it("should keep each project's label color", () => {
			expect.assertions(1);

			const result = build({
				results: [
					{
						displayColor: "magenta",
						displayName: "a",
						pkg: "a",
						result: makeExecuteResult(),
					},
				],
			});

			expect(result.projectResults[0]!.displayColor).toBe("magenta");
		});
	});
});
