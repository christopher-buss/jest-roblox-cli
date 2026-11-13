import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { createRunSeams } from "#test/mocks/run-seams.ts";
import { makeExecuteResult } from "#test/mocks/spec-results.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { CoverageManifest } from "../coverage-data/manifest.ts";
import type { MappedCoverageResult } from "../coverage-report/mapper-types.ts";
import type { ExecuteResult } from "../executor/executor-types.ts";
import type { PartialRun } from "../related/partial-run.ts";
import type { ProjectResult } from "../results/run-result-types.ts";
import { buildMultiRunResult, type MultiRunResultInput } from "./multi-result.ts";
import type { RunSeams } from "./seams.ts";

function input({
	cliFiles,
	partialRun,
	projectNames,
	projectResults = [],
}: {
	cliFiles?: Array<string> | undefined;
	partialRun?: PartialRun | undefined;
	projectNames?: Array<string> | undefined;
	projectResults?: Array<ProjectResult> | undefined;
}): MultiRunResultInput {
	return fromAny<MultiRunResultInput, unknown>({
		cli: { files: cliFiles, project: projectNames },
		discovery: {
			partialRun,
			projects: [],
			rootConfig: { ...createResolvedConfig(), rootDir: "/repo" },
		},
		outcome: {
			placeBuildMs: 5,
			projectResults,
			typecheck: { result: undefined },
		},
		plan: { matchedRuntimeFiles: ["/repo/src/matched.spec.ts"] },
		seams: createRunSeams(),
		staged: { coverageArtifacts: undefined, coverageMs: 17, stagingMs: 7 },
	});
}

describe(buildMultiRunResult, () => {
	it("should preserve an empty full-run result without adding optional merged fields", () => {
		expect.assertions(1);

		expect(buildMultiRunResult(input({}))).toStrictEqual({
			affected: undefined,
			coverage: undefined,
			coverageArtifacts: undefined,
			coverageChangedFiles: undefined,
			coverageDisplayFilter: undefined,
			coverageMs: 17,
			output: expect.objectContaining({ perUnitGameOutput: false, perUnitOutputFile: false }),
			projectResults: [],
			stagingMs: 12,
			typecheckResult: undefined,
		});
	});

	it.for<PartialRun>([
		{ files: ["/repo/src/a.luau"], kind: "changed", since: "HEAD" },
		{ files: ["/repo/src/a.luau"], kind: "related" },
	])("should narrow coverage to the files of a $kind Partial Run", (partialRun) => {
		expect.assertions(2);

		const run = input({ partialRun });
		const result = buildMultiRunResult({
			...run,
			discovery: { ...run.discovery, rootConfig: coverageConfig() },
			outcome: {
				...run.outcome,
				projectResults: [
					{ displayName: "a", result: makeExecuteResult({ coverageData: {} }) },
				],
			},
			seams: createRunSeams({
				mapCoverage: () => {
					return fromAny({
						files: {
							"/repo/src/a.luau": { s: { 0: 0 } },
							"/repo/src/untested.luau": { s: { 0: 0 } },
						},
					});
				},
			}),
			staged: { ...run.staged, coverageManifest: MANIFEST },
		});

		expect(result.coverageChangedFiles).toBe(partialRun.files);
		expect(Object.keys(result.coverage!.units[0]!.universe.files)).toStrictEqual([
			"/repo/src/a.luau",
		]);
	});

	it("should not narrow display coverage for empty positional or project filters", () => {
		expect.assertions(2);

		expect(buildMultiRunResult(input({ cliFiles: [] })).coverageDisplayFilter).toBeUndefined();
		expect(
			buildMultiRunResult(input({ projectNames: [] })).coverageDisplayFilter,
		).toBeUndefined();
	});

	it("should create a source-twin display filter for positional files", () => {
		expect.assertions(2);

		const { coverageDisplayFilter } = buildMultiRunResult(
			input({ cliFiles: ["src/direct.spec.ts"] }),
		);

		const resolvedRoot = path.resolve("/repo").replaceAll("\\", "/");

		expect(coverageDisplayFilter!(`${resolvedRoot}/src/direct.ts`)).toBeTrue();
		expect(coverageDisplayFilter!(`${resolvedRoot}/src/other.ts`)).toBeFalse();
	});
});

const MANIFEST = fromAny<CoverageManifest, unknown>({});
const UNIVERSE = fromAny<MappedCoverageResult, unknown>({ files: {} });

function coverageConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...createResolvedConfig(),
		collectCoverage: true,
		coverageDirectory: "cov",
		rootDir: "/repo",
		...overrides,
	};
}

function coverageOf({
	config,
	hits,
	manifest,
	seams = createRunSeams(),
}: {
	config: ResolvedConfig;
	hits: ExecuteResult["coverageData"];
	manifest?: CoverageManifest;
	seams?: RunSeams;
}): ReturnType<typeof buildMultiRunResult>["coverage"] {
	const run = input({
		projectResults: [{ displayName: "a", result: makeExecuteResult({ coverageData: hits }) }],
	});
	return buildMultiRunResult({
		...run,
		discovery: { ...run.discovery, rootConfig: config },
		seams,
		staged: { ...run.staged, coverageManifest: manifest },
	}).coverage;
}

describe("buildMultiRunResult coverage", () => {
	it("should map nothing when coverage is off", () => {
		expect.assertions(1);

		expect(
			coverageOf({ config: coverageConfig({ collectCoverage: false }), hits: fromAny({}) }),
		).toBeUndefined();
	});

	it("should carry a notice when no coverage data came back", () => {
		expect.assertions(1);

		expect(coverageOf({ config: coverageConfig(), hits: undefined })).toStrictEqual({
			notice: "Warning: coverage data was empty. The Rojo project may point at uninstrumented source",
			units: [],
		});
	});

	it("should carry a notice when the manifest is missing", () => {
		expect.assertions(1);

		expect(
			coverageOf({
				config: coverageConfig(),
				hits: fromAny({}),
			}),
		).toStrictEqual({
			notice: "Warning: Coverage manifest not found, skipping TS mapping",
			units: [],
		});
	});

	it("should map the hits through the staged manifest into one unit", () => {
		expect.assertions(1);

		const mapCoverage = vi.fn<() => MappedCoverageResult>(() => UNIVERSE);
		const config = coverageConfig({
			collectCoverageFrom: ["src/**/*.ts"],
			coverageThreshold: { lines: 80 },
		});

		expect(
			coverageOf({
				config,
				hits: fromAny({ "x.luau": {} }),
				manifest: MANIFEST,
				seams: createRunSeams({ mapCoverage }),
			}),
		).toStrictEqual({
			units: [
				{
					coverageDirectory: path.resolve("/repo", "cov"),
					coverageThreshold: { lines: 80 },
					label: undefined,
					reporters: config.coverageReporters,
					universe: { files: {} },
				},
			],
		});
	});

	it("should map the merged hits of every project under the source globs", () => {
		expect.assertions(2);

		function mapCoverage({
			coverageData,
		}: Parameters<RunSeams["mapCoverage"]>[0]): MappedCoverageResult {
			return fromAny({ files: coverageData });
		}

		const run = input({
			projectResults: [
				{
					displayName: "a",
					result: makeExecuteResult({
						coverageData: fromAny({ "a.luau": { s: { "0": 1 } } }),
					}),
				},
				{
					displayName: "b",
					result: makeExecuteResult({
						coverageData: fromAny({ "b.luau": { s: { "0": 1 } } }),
					}),
				},
			],
		});
		const result = buildMultiRunResult({
			...run,
			discovery: {
				...run.discovery,
				rootConfig: coverageConfig(),
			},
			seams: createRunSeams({ mapCoverage }),
			staged: { ...run.staged, coverageManifest: MANIFEST },
		});

		expect(result.coverage!.units).toHaveLength(1);
		expect(result.coverage!.units[0]!.universe.files).toStrictEqual(
			fromAny<MappedCoverageResult["files"], unknown>({
				"a.luau": { s: { "0": 1 } },
				"b.luau": { s: { "0": 1 } },
			}),
		);
	});
});
