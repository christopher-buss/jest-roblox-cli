import { fromAny } from "@total-typescript/shoehorn";

import { assert, describe, expect, it } from "vitest";

import { emptyPending, pendingResult } from "#test/mocks/coverage-instr-pending.ts";
import { mapSourceMappedFile } from "./mapper-source-mapped.ts";
import type { MappedFileCoverage, PositionResolver } from "./mapper-types.ts";

interface FileLocation {
	end: { column: number; line: number };
	start: { column: number; line: number };
}

type Mappings = Record<string, { column: number; line: number; source: string }>;

function createResolver(mappings: Mappings): PositionResolver {
	return (position) => {
		const mapping = mappings[`${String(position.line)}:${String(position.column)}`];
		return mapping ?? { column: null, line: null, source: null };
	};
}

function runFile({
	hitCounts,
	mappings,
	statementMap,
}: {
	hitCounts: Record<string, number>;
	mappings: Mappings;
	statementMap: Record<string, FileLocation>;
}): MappedFileCoverage {
	const pending = emptyPending();
	mapSourceMappedFile({
		fileCoverage: { s: hitCounts },
		pending,
		resources: {
			coverageMap: fromAny({ statementMap }),
			resolvePosition: createResolver(mappings),
			sourceMapDirectory: "out/shared",
		},
	});

	const file = pendingResult(pending).files["src/shared/player.ts"];
	assert(file !== undefined, "fixture statements map to src/shared/player.ts");
	return file;
}

describe(mapSourceMappedFile, () => {
	describe("with one source statement lowered to several Luau statements", () => {
		// `const [first, second] = buildPair(\n\tinput,\n);` on TS line 10.
		// roblox-ts lowers it to a `local _binding = ...` mapped across the
		// call's three source lines, plus one single-line fragment per bound
		// name, each mapped to its own column of line 10.
		const bindingSpan = { end: { column: 33, line: 20 }, start: { column: 1, line: 20 } };
		const firstSpan = { end: { column: 26, line: 21 }, start: { column: 1, line: 21 } };
		const secondSpan = { end: { column: 27, line: 22 }, start: { column: 1, line: 22 } };

		const destructuringMappings: Mappings = {
			// `local _binding = buildPair(input)`
			"20:0": { column: 0, line: 10, source: "src/shared/player.ts" },
			"20:32": { column: 1, line: 12, source: "src/shared/player.ts" },
			// `local first = _binding[1]`
			"21:0": { column: 7, line: 10, source: "src/shared/player.ts" },
			"21:25": { column: 12, line: 10, source: "src/shared/player.ts" },
			// `local second = _binding[2]`
			"22:0": { column: 14, line: 10, source: "src/shared/player.ts" },
			"22:26": { column: 20, line: 10, source: "src/shared/player.ts" },
		};

		it("should record one entry per source statement", () => {
			expect.assertions(2);

			const file = runFile({
				hitCounts: { "0": 3, "1": 3, "2": 3 },
				mappings: destructuringMappings,
				statementMap: { "0": bindingSpan, "1": firstSpan, "2": secondSpan },
			});

			expect(Object.keys(file.statementMap)).toHaveLength(1);
			expect(file.statementMap["0"]).toStrictEqual({
				end: { column: 1, line: 12 },
				start: { column: 0, line: 10 },
			});
		});

		it("should sum the fragment hit counts rather than splitting them", () => {
			expect.assertions(1);

			const file = runFile({
				hitCounts: { "0": 3, "1": 3, "2": 3 },
				mappings: destructuringMappings,
				statementMap: { "0": bindingSpan, "1": firstSpan, "2": secondSpan },
			});

			expect(file.s["0"]).toBe(9);
		});

		it("should widen the entry start when a fragment is recorded first", () => {
			expect.assertions(2);

			// A fragment lands before the statement start does. The entry takes
			// the leftmost column, so it still covers the whole source
			// statement.
			const file = runFile({
				hitCounts: { "0": 4, "1": 4 },
				mappings: destructuringMappings,
				statementMap: { "0": firstSpan, "1": bindingSpan },
			});

			expect(Object.keys(file.statementMap)).toHaveLength(1);
			expect(file.statementMap["0"]).toStrictEqual({
				end: { column: 1, line: 12 },
				start: { column: 0, line: 10 },
			});
		});

		it("should keep single-line statements that merely share a line apart", () => {
			expect.assertions(1);

			// `first(); second();`: two source statements, neither spanning
			// lines. Nothing marks them as fragments of one statement, so they
			// stay separate.
			const file = runFile({
				hitCounts: { "0": 1, "1": 1 },
				mappings: {
					"20:0": { column: 0, line: 10, source: "src/shared/player.ts" },
					"20:9": { column: 8, line: 10, source: "src/shared/player.ts" },
					"21:0": { column: 10, line: 10, source: "src/shared/player.ts" },
					"21:10": { column: 19, line: 10, source: "src/shared/player.ts" },
				},
				statementMap: {
					"0": { end: { column: 10, line: 20 }, start: { column: 1, line: 20 } },
					"1": { end: { column: 11, line: 21 }, start: { column: 1, line: 21 } },
				},
			});

			expect(Object.keys(file.statementMap)).toStrictEqual(["0", "1"]);
		});
	});
});
