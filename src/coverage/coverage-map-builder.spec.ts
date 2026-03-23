import { describe, expect, it } from "vitest";

import type { CollectorResult } from "./coverage-collector.ts";
import { buildCoverageMap } from "./coverage-map-builder.ts";

function emptyResult(): CollectorResult {
	return {
		branches: [],
		exprIfProbes: [],
		functions: [],
		implicitElseProbes: [],
		statements: [],
	};
}

describe("covmap-builder", () => {
	describe(buildCoverageMap, () => {
		it("should return empty maps for empty result", () => {
			expect.assertions(1);

			const coverageMap = buildCoverageMap(emptyResult());

			expect(coverageMap).toStrictEqual({
				branchMap: {},
				functionMap: {},
				statementMap: {},
			});
		});

		it("should build statementMap with 1-based string keys", () => {
			expect.assertions(2);

			const result = {
				...emptyResult(),
				statements: [
					{
						index: 1,
						location: { begincolumn: 1, beginline: 1, endcolumn: 12, endline: 1 },
					},
					{
						index: 2,
						location: { begincolumn: 1, beginline: 2, endcolumn: 9, endline: 2 },
					},
				],
			} satisfies CollectorResult;

			const coverageMap = buildCoverageMap(result);

			expect(coverageMap.statementMap["1"]).toStrictEqual({
				end: { column: 12, line: 1 },
				start: { column: 1, line: 1 },
			});
			expect(coverageMap.statementMap["2"]).toStrictEqual({
				end: { column: 9, line: 2 },
				start: { column: 1, line: 2 },
			});
		});

		it("should build functionMap with name and location", () => {
			expect.assertions(2);

			const result = {
				...emptyResult(),
				functions: [
					{
						name: "greet",
						bodyFirstColumn: 5,
						bodyFirstLine: 2,
						index: 1,
						location: { begincolumn: 1, beginline: 1, endcolumn: 4, endline: 3 },
					},
				],
			} satisfies CollectorResult;

			const coverageMap = buildCoverageMap(result);

			expect(coverageMap.functionMap).toBeDefined();
			expect(coverageMap.functionMap!["1"]).toStrictEqual({
				name: "greet",
				location: {
					end: { column: 4, line: 3 },
					start: { column: 1, line: 1 },
				},
			});
		});

		it("should build branchMap with type and arm locations", () => {
			expect.assertions(2);

			const result = {
				...emptyResult(),
				branches: [
					{
						arms: [
							{
								bodyFirstColumn: 5,
								bodyFirstLine: 2,
								location: {
									begincolumn: 13,
									beginline: 1,
									endcolumn: 1,
									endline: 3,
								},
							},
							{
								bodyFirstColumn: 5,
								bodyFirstLine: 4,
								location: {
									begincolumn: 5,
									beginline: 3,
									endcolumn: 1,
									endline: 5,
								},
							},
						],
						branchType: "if",
						index: 1,
					},
				],
			} satisfies CollectorResult;

			const coverageMap = buildCoverageMap(result);

			expect(coverageMap.branchMap).toBeDefined();
			expect(coverageMap.branchMap!["1"]).toStrictEqual({
				locations: [
					{ end: { column: 1, line: 3 }, start: { column: 13, line: 1 } },
					{ end: { column: 1, line: 5 }, start: { column: 5, line: 3 } },
				],
				type: "if",
			});
		});
	});
});
