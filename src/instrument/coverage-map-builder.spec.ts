import { describe, expect, it } from "vitest";

import { asciiColumn, asciiSpan } from "#test/mocks/ascii-columns.ts";
import { COLLECTED_FIXTURES } from "#test/mocks/coverage-collected-fixtures.ts";
import type { CollectorResult } from "./coverage-accumulator.ts";
import { buildCoverageMap } from "./coverage-map-builder.ts";

function emptyResult(): CollectorResult {
	return {
		branches: [],
		functions: [],
		implicitElseProbes: [],
		statements: [],
		wrapProbes: [],
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
						location: asciiSpan({
							beginColumn: 1,
							beginLine: 1,
							endColumn: 12,
							endLine: 1,
						}),
					},
					{
						index: 2,
						location: asciiSpan({
							beginColumn: 1,
							beginLine: 2,
							endColumn: 9,
							endLine: 2,
						}),
					},
				],
			} satisfies CollectorResult;

			const coverageMap = buildCoverageMap(result);

			expect(coverageMap.statementMap["1"]).toStrictEqual({
				end: { column: asciiColumn(12), line: 1 },
				start: { column: asciiColumn(1), line: 1 },
			});
			expect(coverageMap.statementMap["2"]).toStrictEqual({
				end: { column: asciiColumn(9), line: 2 },
				start: { column: asciiColumn(1), line: 2 },
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
						location: asciiSpan({
							beginColumn: 1,
							beginLine: 1,
							endColumn: 4,
							endLine: 3,
						}),
					},
				],
			} satisfies CollectorResult;

			const coverageMap = buildCoverageMap(result);

			expect(coverageMap.functionMap).toBeDefined();
			expect(coverageMap.functionMap!["1"]).toStrictEqual({
				name: "greet",
				location: {
					end: { column: asciiColumn(4), line: 3 },
					start: { column: asciiColumn(1), line: 1 },
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
								location: asciiSpan({
									beginColumn: 13,
									beginLine: 1,
									endColumn: 1,
									endLine: 3,
								}),
							},
							{
								bodyFirstColumn: 5,
								bodyFirstLine: 4,
								location: asciiSpan({
									beginColumn: 5,
									beginLine: 3,
									endColumn: 1,
									endLine: 5,
								}),
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
					{
						end: { column: asciiColumn(1), line: 3 },
						start: { column: asciiColumn(13), line: 1 },
					},
					{
						end: { column: asciiColumn(1), line: 5 },
						start: { column: asciiColumn(5), line: 3 },
					},
				],
				type: "if",
			});
		});
	});
});

function fixtureMap(name: string) {
	return buildCoverageMap(COLLECTED_FIXTURES[name]!.result);
}

describe("coverage maps of collected fixtures", () => {
	it.for([
		"simple.luau",
		"empty.luau",
		"if-only.luau",
		"functions.luau",
		"if-else.luau",
		"expr-if.luau",
		"and-or.luau",
	])("should build the expected cov-map for %s", (name) => {
		expect.assertions(1);

		expect(fixtureMap(name)).toMatchSnapshot();
	});

	it("should name declared, global and anonymous functions", () => {
		expect.assertions(1);

		const names = Object.values(fixtureMap("functions.luau").functionMap!).map((entry) => {
			return entry.name;
		});

		expect(names).toIncludeAllMembers(["greet", "globalFunc", "(anonymous)"]);
	});

	it("should record one if branch with three arms for if/elseif/else", () => {
		expect.assertions(3);

		const { branchMap } = fixtureMap("if-else.luau");

		expect(Object.values(branchMap!)).toHaveLength(1);
		expect(branchMap!["1"]!.locations).toHaveLength(3);
		expect(branchMap!["1"]!.type).toBe("if");
	});

	it("should record the implicit else arm of an if without else", () => {
		expect.assertions(2);

		const { branchMap } = fixtureMap("if-only.luau");

		expect(Object.values(branchMap!)).toHaveLength(1);
		expect(branchMap!["1"]!.locations).toHaveLength(2);
	});

	it("should leave the ignored sites out of the cov-map", () => {
		expect.assertions(3);

		const covMap = fixtureMap("ignore-directives.luau");

		expect(Object.values(covMap.functionMap!).map((entry) => entry.name)).toStrictEqual([
			"check",
		]);
		expect(
			Object.values(covMap.branchMap!).map((entry) => entry.locations.length),
		).toStrictEqual([1, 2]);
		expect(
			Object.values(covMap.statementMap)
				.map((entry) => entry.start.line)
				.toSorted((left, right) => left - right),
		).toStrictEqual([1, 3, 7, 8, 10, 14, 22]);
	});

	it("should record expr-if branches with two and three arms", () => {
		expect.assertions(3);

		const { branchMap } = fixtureMap("expr-if.luau");

		expect(Object.values(branchMap!).map((entry) => entry.type)).toStrictEqual([
			"expr-if",
			"expr-if",
		]);
		expect(branchMap!["1"]!.locations).toHaveLength(2);
		expect(branchMap!["2"]!.locations).toHaveLength(3);
	});

	it("should record each and/or as a two-arm binary-expr branch", () => {
		expect.assertions(3);

		const entries = Object.values(fixtureMap("and-or.luau").branchMap!);

		expect(entries).toHaveLength(4);
		expect(entries.every((entry) => entry.type === "binary-expr")).toBeTrue();
		expect(entries.every((entry) => entry.locations.length === 2)).toBeTrue();
	});
});
