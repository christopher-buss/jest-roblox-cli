import type { MappedFileCoverage } from "#src/coverage-pipeline/mapper-types.ts";

export function mappedFile(overrides: Partial<MappedFileCoverage>): MappedFileCoverage {
	return {
		b: {},
		branchMap: {},
		f: { "0": 2 },
		fnMap: {
			"0": {
				name: "fn",
				loc: { end: { column: 1, line: 5 }, start: { column: 0, line: 1 } },
			},
		},
		path: "src/client/player.ts",
		s: { "0": 3, "1": 0, "2": 5 },
		statementMap: {
			"0": { end: { column: 20, line: 1 }, start: { column: 0, line: 1 } },
			"1": { end: { column: 15, line: 3 }, start: { column: 0, line: 3 } },
			"2": { end: { column: 10, line: 5 }, start: { column: 0, line: 5 } },
		},
		...overrides,
	};
}
