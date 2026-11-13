import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { emptyPending, pendingResult } from "#test/mocks/coverage-instr-pending.ts";
import { createCoverageMap } from "#test/mocks/coverage-spec-mapper.ts";
import type { CoverageMapFile } from "#test/mocks/coverage-spec-mapper.ts";
import type { RawCoverageData } from "../coverage-data/coverage-types.ts";
import { passthroughFile } from "./mapper-passthrough.ts";
import type { MappedFileCoverage } from "./mapper-types.ts";

function twoArmIfMap(): CoverageMapFile {
	return createCoverageMap(
		{ "0": { end: { column: 10, line: 1 }, start: { column: 1, line: 1 } } },
		{
			branchMap: {
				"0": {
					locations: [
						{ end: { column: 10, line: 3 }, start: { column: 1, line: 3 } },
						{ end: { column: 10, line: 5 }, start: { column: 1, line: 5 } },
					],
					type: "if",
				},
			},
		},
	);
}

function mapNativeFile(
	coverageMap: CoverageMapFile,
	fileCoverage: RawCoverageData[string],
): MappedFileCoverage {
	const pending = emptyPending();
	passthroughFile({
		fileCoverage,
		pending,
		resources: {
			coverageMap: fromAny(coverageMap),
			resolvePosition: undefined,
			sourceKey: "shared/player.luau",
			sourceMapDirectory: "out/shared",
		},
	});

	return pendingResult(pending).files["shared/player.luau"]!;
}

describe(passthroughFile, () => {
	it("should report statement coverage against the original Luau path", () => {
		expect.assertions(3);

		const coverageMap = createCoverageMap({
			"0": {
				end: { column: 20, line: 3 },
				start: { column: 1, line: 1 },
			},
		});

		// Only cov-map exists; no .luau.map source map
		const file = mapNativeFile(coverageMap, { s: { "0": 5 } });

		expect(file).toBeDefined();
		expect(file.s["0"]).toBe(5);
		expect(file.statementMap["0"]).toStrictEqual({
			end: { column: 19, line: 3 },
			start: { column: 0, line: 1 },
		});
	});

	it("should passthrough function coverage for native Luau files", () => {
		expect.assertions(3);

		const coverageMap = createCoverageMap(
			{
				"0": {
					end: { column: 10, line: 1 },
					start: { column: 1, line: 1 },
				},
			},
			{
				functionMap: {
					"0": {
						name: "greet",
						location: {
							end: { column: 4, line: 5 },
							start: { column: 1, line: 3 },
						},
					},
				},
			},
		);

		const file = mapNativeFile(coverageMap, { f: { "0": 3 }, s: { "0": 1 } });

		expect(file.fnMap["0"]!.name).toBe("greet");
		expect(file.f["0"]).toBe(3);
		expect(file.fnMap["0"]!.loc).toStrictEqual({
			end: { column: 3, line: 5 },
			start: { column: 0, line: 3 },
		});
	});

	it("should passthrough branch coverage for native Luau files", () => {
		expect.assertions(3);

		const coverageMap = twoArmIfMap();

		const file = mapNativeFile(coverageMap, { b: { "0": [2, 1] }, s: { "0": 1 } });

		expect(file.b["0"]).toStrictEqual([2, 1]);
		expect(file.branchMap["0"]!.type).toBe("if");
		expect(file.branchMap["0"]!.locations).toStrictEqual([
			{ end: { column: 9, line: 3 }, start: { column: 0, line: 3 } },
			{ end: { column: 9, line: 5 }, start: { column: 0, line: 5 } },
		]);
	});

	it("should skip function passthrough when functionMap is undefined", () => {
		expect.assertions(1);

		const coverageMap = createCoverageMap({
			"0": {
				end: { column: 10, line: 1 },
				start: { column: 1, line: 1 },
			},
		});

		const file = mapNativeFile(coverageMap, { s: { "0": 1 } });

		expect(file.fnMap).toBeEmptyObject();
	});

	it("should skip branch passthrough when branchMap is undefined", () => {
		expect.assertions(1);

		const coverageMap = createCoverageMap({
			"0": {
				end: { column: 10, line: 1 },
				start: { column: 1, line: 1 },
			},
		});

		const file = mapNativeFile(coverageMap, { s: { "0": 1 } });

		expect(file.branchMap).toBeEmptyObject();
	});

	it("should skip branch passthrough entries with empty locations array", () => {
		expect.assertions(1);

		const coverageMap = createCoverageMap(
			{},
			{
				branchMap: {
					"0": { locations: [], type: "if" },
				},
			},
		);

		const file = mapNativeFile(coverageMap, { b: { "0": [] }, s: {} });

		expect(file.branchMap).toBeEmptyObject();
	});

	it("should default function hit count to zero when not in raw data", () => {
		expect.assertions(1);

		const coverageMap = createCoverageMap(
			{
				"0": {
					end: { column: 10, line: 1 },
					start: { column: 1, line: 1 },
				},
			},
			{
				functionMap: {
					"0": {
						name: "foo",
						location: {
							end: { column: 4, line: 5 },
							start: { column: 1, line: 3 },
						},
					},
				},
			},
		);

		const file = mapNativeFile(coverageMap, { s: { "0": 1 } });

		expect(file.f["0"]).toBe(0);
	});

	it("should default branch arm hit counts to zero when not in raw data", () => {
		expect.assertions(1);

		const coverageMap = twoArmIfMap();

		const file = mapNativeFile(coverageMap, { s: { "0": 1 } });

		expect(file.b["0"]).toStrictEqual([0, 0]);
	});

	it("should default statement hit count to zero when ID is absent from raw data", () => {
		expect.assertions(1);

		const coverageMap = createCoverageMap({
			"0": {
				end: { column: 20, line: 3 },
				start: { column: 1, line: 1 },
			},
		});

		// Statement "0" is not in the s record
		const file = mapNativeFile(coverageMap, { s: {} });

		expect(file.s["0"]).toBe(0);
	});
});
