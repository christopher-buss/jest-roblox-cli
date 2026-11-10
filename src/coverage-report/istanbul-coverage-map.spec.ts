import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { buildCoverageMap } from "./istanbul-coverage-map.ts";

const LOC = { end: { column: 1, line: 5 }, start: { column: 0, line: 2 } };

describe(buildCoverageMap, () => {
	it("should key each file by its absolute path and add the line and decl istanbul expects", () => {
		expect.assertions(3);

		const coverageMap = buildCoverageMap({
			files: {
				"src/player.ts": {
					b: { "0": [1, 0] },
					branchMap: { "0": { loc: LOC, locations: [LOC, LOC], type: "if" } },
					f: { "0": 2 },
					fnMap: { "0": { name: "greet", loc: LOC } },
					path: "src/player.ts",
					s: { "0": 3 },
					statementMap: { "0": LOC },
				},
			},
		});

		const absolute = path.resolve("src/player.ts");
		const { data } = coverageMap.fileCoverageFor(absolute);

		expect(coverageMap.files()).toStrictEqual([absolute]);
		expect(data.branchMap["0"]).toStrictEqual({
			line: 2,
			loc: LOC,
			locations: [LOC, LOC],
			type: "if",
		});
		expect(data.fnMap["0"]).toStrictEqual({ name: "greet", decl: LOC, line: 2, loc: LOC });
	});
});
