import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { AttributionResult } from "../coverage-pipeline/attribution.ts";
import type { SourceMapper } from "../source-mapper/index.ts";
import { buildMultiRunResult, type MultiRunResultInput } from "./multi-result.ts";
import type { ProjectResult } from "./types.ts";

function input({
	cliFiles,
	projectNames,
	projectResults = [],
}: {
	cliFiles?: Array<string> | undefined;
	projectNames?: Array<string> | undefined;
	projectResults?: Array<ProjectResult> | undefined;
}): MultiRunResultInput {
	return fromAny<MultiRunResultInput, unknown>({
		cli: { files: cliFiles, project: projectNames },
		discovery: {
			projects: [],
			rootConfig: { ...DEFAULT_CONFIG, rootDir: "/repo" },
		},
		outcome: {
			placeBuildMs: 5,
			projectResults,
			typecheck: { result: undefined },
		},
		plan: { matchedRuntimeFiles: ["/repo/src/matched.spec.ts"] },
		staged: { coverageArtifacts: undefined, coverageMs: 17, stagingMs: 7 },
	});
}

describe(buildMultiRunResult, () => {
	it("should preserve an empty full-run result without adding optional merged fields", () => {
		expect.assertions(1);

		expect(buildMultiRunResult(input({}))).toStrictEqual({
			collectCoverageFrom: undefined,
			coverageArtifacts: undefined,
			coverageDisplayFilter: undefined,
			coverageMs: 17,
			merged: {},
			mode: "multi",
			projectResults: [],
			stagingMs: 12,
			typecheckResult: undefined,
		});
	});

	it("should not narrow display coverage for empty positional or project filters", () => {
		expect.assertions(2);

		expect(buildMultiRunResult(input({ cliFiles: [] })).coverageDisplayFilter).toBeUndefined();
		expect(
			buildMultiRunResult(input({ projectNames: [] })).coverageDisplayFilter,
		).toBeUndefined();
	});

	it("should merge coverage, attribution, and a source mapper from project results", () => {
		expect.assertions(3);

		const attribution: AttributionResult = {
			coveringTestIds: {},
			staticStatementIds: {},
			tests: [],
		};
		const sourceMapper = fromAny<SourceMapper, unknown>({
			mapFailureWithLocations: () => ({ locations: [], message: "mapped" }),
			resolveDisplayPath: () => "display.ts",
			resolveTestFilePath: () => "source.ts",
		});
		const projectResults = [
			fromAny<ProjectResult, unknown>({
				displayName: "project",
				result: {
					attribution,
					coverageData: { "file.luau": { s: { "1": 2 } } },
					sourceMapper,
				},
			}),
		];

		const { merged } = buildMultiRunResult(input({ projectResults }));

		expect(merged.coverageData).toStrictEqual({ "file.luau": { s: { "1": 2 } } });
		expect(merged.attribution).toBe(attribution);
		expect(merged.sourceMapper).toBe(sourceMapper);
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
