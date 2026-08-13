import type { LuauSpan } from "@isentinel/luau-ast";

import { describe, expect, it } from "vitest";

import type { CollectorResult } from "./coverage-accumulator.ts";
import { toUtf16Columns } from "./utf16-columns.ts";

type BranchArm = CollectorResult["branches"][number]["arms"][number];

function emptyResult(): CollectorResult {
	return {
		branches: [],
		functions: [],
		implicitElseProbes: [],
		statements: [],
		wrapProbes: [],
	};
}

/** A span within one line — every source under test here is one statement. */
function span(line: number, beginColumn: number, endColumn: number): LuauSpan {
	return { beginColumn, beginLine: line, endColumn, endLine: line };
}

function statementResult(location: LuauSpan): CollectorResult {
	return { ...emptyResult(), statements: [{ index: 1, location }] };
}

function branchResult(arm: BranchArm, branchType: string): CollectorResult {
	return { ...emptyResult(), branches: [{ arms: [arm], branchType, index: 1 }] };
}

describe("utf16-columns", () => {
	describe(toUtf16Columns, () => {
		it("should leave the columns of an ASCII source alone", () => {
			expect.assertions(1);

			const converted = toUtf16Columns(statementResult(span(1, 1, 12)), "local x = 1\n");

			expect(converted.statements[0]!.location).toStrictEqual(span(1, 1, 12));
		});

		// `local a = "∞" 1` — the closing quote is byte column 15 and UTF-16
		// column 13, because U+221E is three bytes and one UTF-16 unit.
		it("should subtract the extra bytes of a preceding character", () => {
			expect.assertions(2);

			const source = 'local a = "\u{221E}" 1\n';
			const converted = toUtf16Columns(statementResult(span(1, 11, 15)), source);
			const { location } = converted.statements[0]!;

			expect(location.beginColumn).toBe(11);
			expect(location.endColumn).toBe(13);
		});

		// An astral character is four bytes but two UTF-16 units, so a column
		// past it drifts by two rather than by three.
		it("should count an astral character as two UTF-16 units", () => {
			expect.assertions(1);

			const source = 'local a = "\u{1F389}"\n';
			const converted = toUtf16Columns(statementResult(span(1, 1, 16)), source);

			expect(converted.statements[0]!.location.endColumn).toBe(14);
		});

		// A span that ends the line ends one byte past it, which is one UTF-16
		// unit past it too.
		it("should convert an end column that sits past the last byte", () => {
			expect.assertions(1);

			const source = 'local a = "\u{221E}"\n';
			const converted = toUtf16Columns(statementResult(span(1, 1, 16)), source);

			expect(converted.statements[0]!.location.endColumn).toBe(14);
		});

		it("should convert only the lines that hold a multi-byte character", () => {
			expect.assertions(2);

			const source = 'local a = "\u{221E}"\nlocal b = "yes"\n';
			const converted = toUtf16Columns(
				{
					...emptyResult(),
					statements: [
						{ index: 1, location: span(1, 11, 15) },
						{ index: 2, location: span(2, 11, 16) },
					],
				},
				source,
			);

			expect(converted.statements[0]!.location.endColumn).toBe(13);
			expect(converted.statements[1]!.location.endColumn).toBe(16);
		});

		it("should carry a carriage return as part of the line it ends", () => {
			expect.assertions(1);

			const source = 'local a = "\u{221E}"\r\nlocal b = 2\r\n';
			const converted = toUtf16Columns(statementResult(span(1, 1, 15)), source);

			expect(converted.statements[0]!.location.endColumn).toBe(13);
		});

		it("should convert the body position of a function and of a branch arm", () => {
			expect.assertions(3);

			const source = 'local f = function() return "\u{221E}", 1 end\n';
			const converted = toUtf16Columns(
				{
					...branchResult(
						{ bodyFirstColumn: 36, bodyFirstLine: 1, location: span(1, 29, 34) },
						"if",
					),
					functions: [
						{
							name: "f",
							bodyFirstColumn: 22,
							bodyFirstLine: 1,
							index: 1,
							location: span(1, 11, 41),
						},
					],
				},
				source,
			);

			expect(converted.functions[0]!.location.endColumn).toBe(39);
			expect(converted.branches[0]!.arms[0]!.location.endColumn).toBe(32);
			expect(converted.branches[0]!.arms[0]!.bodyFirstColumn).toBe(34);
		});

		// `bodyFirstLine`/`bodyFirstColumn` of 0 is the "wrap probe, not point
		// probe" sentinel — it names no position, so it must survive untouched.
		it("should leave the wrap-probe sentinel at zero", () => {
			expect.assertions(1);

			const converted = toUtf16Columns(
				branchResult(
					{ bodyFirstColumn: 0, bodyFirstLine: 0, location: span(1, 11, 15) },
					"binary-expr",
				),
				'local a = "\u{221E}"\n',
			);

			expect(converted.branches[0]!.arms[0]!.bodyFirstColumn).toBe(0);
		});

		it("should convert implicit-else probe and wrap positions", () => {
			expect.assertions(2);

			const source = 'if x then return "\u{221E}" end\n';
			const converted = toUtf16Columns(
				{
					...emptyResult(),
					implicitElseProbes: [
						{ armIndex: 2, branchIndex: 1, endColumn: 25, endLine: 1 },
					],
					wrapProbes: [{ armIndex: 1, branchIndex: 1, exprLocation: span(1, 18, 23) }],
				},
				source,
			);

			expect(converted.implicitElseProbes[0]!.endColumn).toBe(23);
			expect(converted.wrapProbes[0]!.exprLocation.endColumn).toBe(21);
		});
	});
});
