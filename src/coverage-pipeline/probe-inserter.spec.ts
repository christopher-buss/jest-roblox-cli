import type { LuauSpan } from "@isentinel/luau-ast/ast";
import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { COLLECTED_FIXTURES } from "#test/mocks/coverage-collected-fixtures.ts";
import type { CollectorResult } from "./coverage-collector.ts";
import { insertProbes } from "./probe-inserter.ts";

function insert({
	fileKey,
	result,
	source,
}: {
	fileKey: string;
	result: CollectorResult<LuauSpan>;
	source: string;
}): string {
	return insertProbes({
		fileKey,
		result: fromAny<CollectorResult, CollectorResult<LuauSpan>>(result),
		source,
	});
}

function emptyResult(): CollectorResult<LuauSpan> {
	return {
		branches: [],
		functions: [],
		implicitElseProbes: [],
		statements: [],
		wrapProbes: [],
	};
}

function singleStatementResult(): CollectorResult<LuauSpan> {
	return {
		...emptyResult(),
		statements: [
			{
				index: 1,
				location: { beginColumn: 1, beginLine: 1, endColumn: 12, endLine: 1 },
			},
		],
	};
}

function twoStatementResult(): CollectorResult<LuauSpan> {
	return {
		...emptyResult(),
		statements: [
			{
				index: 1,
				location: { beginColumn: 1, beginLine: 1, endColumn: 12, endLine: 1 },
			},
			{
				index: 2,
				location: { beginColumn: 1, beginLine: 2, endColumn: 9, endLine: 2 },
			},
		],
	};
}

function noopFunctionResult({
	bodyFirstColumn,
	bodyFirstLine,
}: {
	bodyFirstColumn: number;
	bodyFirstLine: number;
}): CollectorResult<LuauSpan> {
	return {
		...emptyResult(),
		functions: [
			{
				name: "noop",
				bodyFirstColumn,
				bodyFirstLine,
				index: 1,
				location: { beginColumn: 1, beginLine: 1, endColumn: 26, endLine: 1 },
			},
		],
		statements: [
			{
				index: 1,
				location: { beginColumn: 1, beginLine: 1, endColumn: 26, endLine: 1 },
			},
		],
	};
}

function binaryArm({
	beginColumn,
	endColumn,
	line = 1,
}: {
	beginColumn: number;
	endColumn: number;
	line?: number;
}): CollectorResult<LuauSpan>["branches"][number]["arms"][number] {
	return {
		bodyFirstColumn: 0,
		bodyFirstLine: 0,
		location: { beginColumn, beginLine: line, endColumn, endLine: line },
	};
}

function wrap({
	armIndex,
	beginColumn,
	branchIndex,
	endColumn,
	line = 1,
}: {
	armIndex: number;
	beginColumn: number;
	branchIndex: number;
	endColumn: number;
	line?: number;
}): CollectorResult<LuauSpan>["wrapProbes"][number] {
	return {
		armIndex,
		branchIndex,
		exprLocation: { beginColumn, beginLine: line, endColumn, endLine: line },
	};
}

describe("probe-inserter", () => {
	describe(insertProbes, () => {
		// A file that is nothing but its directive run has nowhere to put a
		// preamble: appended, it lands inside the comment; prepended, the
		// directive stops opening the file. Nothing to count either, so nothing
		// to declare.
		it("should leave a file with no coverage sites verbatim", () => {
			expect.assertions(3);

			expect(
				insert({
					fileKey: "test.luau",
					result: emptyResult(),
					source: "--!strict\n",
				}),
			).toBe("--!strict\n");
			expect(
				insert({
					fileKey: "test.luau",
					result: emptyResult(),
					source: "--!strict\n--!native\n",
				}),
			).toBe("--!strict\n--!native\n");
			expect(
				insert({
					fileKey: "test.luau",
					result: emptyResult(),
					source: "-- one\n-- two\n",
				}),
			).toBe("-- one\n-- two");
		});

		it("should declare the function bucket for a file whose only sites are functions", () => {
			expect.assertions(3);

			const collector: CollectorResult<LuauSpan> = {
				...emptyResult(),
				functions: [
					{
						name: "f",
						bodyFirstColumn: 0,
						bodyFirstLine: 0,
						index: 1,
						location: { beginColumn: 1, beginLine: 1, endColumn: 4, endLine: 2 },
					},
				],
			};

			const result = insert({
				fileKey: "test.luau",
				result: collector,
				source: "local function f()\nend",
			});

			expect(result).toContain("local __cov_f =");
			expect(result).toContain("for __i = 1, 1 do if __cov_f");
			expect(result).not.toContain("__cov_s[__i]");
		});

		it("should declare the branch bucket for a file whose only sites are branches", () => {
			expect.assertions(2);

			const collector: CollectorResult<LuauSpan> = {
				...emptyResult(),
				branches: [
					{
						arms: [
							binaryArm({ beginColumn: 1, endColumn: 2 }),
							binaryArm({ beginColumn: 3, endColumn: 4 }),
						],
						branchType: "expr-if",
						index: 1,
					},
				],
			};

			const result = insert({
				fileKey: "test.luau",
				result: collector,
				source: "local x = a or b",
			});

			expect(result).toContain("local __cov_b =");
			expect(result).not.toContain("__cov_s[__i]");
		});

		// The one case no fixture in `test/fixtures/coverage-pipeline` covers:
		// a leading mode directive, which the fold has to skip past. The branch
		// count is what used to grow the shift, so it varies here too.
		it("should keep every original line at its original line number", () => {
			expect.assertions(2);

			const source = '--!strict\nlocal a = 1\nlocal b = 2\nerror("boom")';
			const collector: CollectorResult<LuauSpan> = {
				...emptyResult(),
				branches: Array.from({ length: 12 }, (_unused, index) => {
					return {
						arms: [
							binaryArm({ beginColumn: 1, endColumn: 2, line: 2 }),
							binaryArm({ beginColumn: 3, endColumn: 4, line: 2 }),
						],
						branchType: "expr-if" as const,
						index: index + 1,
					};
				}),
			};

			const result = insert({ fileKey: "test.luau", result: collector, source });

			const lines = result.split("\n");

			expect(lines).toHaveLength(4);
			expect(lines[3]).toBe('error("boom")');
		});

		it("should declare only the buckets the file's sites need", () => {
			expect.assertions(5);

			const source = "local x = 1";
			const collector = singleStatementResult();

			const result = insert({ fileKey: "test.luau", result: collector, source });

			expect(result).toContain("_G.__jest_roblox_cov");
			expect(result).toContain('__cov_file_key = "test.luau"');
			expect(result).not.toContain("local __cov_f =");
			expect(result).not.toContain("local __cov_b =");
			// Pins the statement-only preamble verbatim; the contract test below
			// pins the shape once every bucket is in play.
			expect(result).toMatchSnapshot();
		});

		it("should preserve the complete instrumentation contract", () => {
			expect.assertions(2);

			const source = "--!strict\nlocal x = if flag then 1 else 2";
			const collector: CollectorResult<LuauSpan> = {
				...emptyResult(),
				branches: [
					{
						arms: [
							binaryArm({ beginColumn: 24, endColumn: 25, line: 2 }),
							binaryArm({ beginColumn: 31, endColumn: 32, line: 2 }),
						],
						branchType: "expr-if",
						index: 1,
					},
				],
				functions: [
					{
						name: "fixture",
						bodyFirstColumn: 1,
						bodyFirstLine: 2,
						index: 1,
						location: { beginColumn: 1, beginLine: 2, endColumn: 32, endLine: 2 },
					},
				],
				statements: [
					{
						index: 1,
						location: { beginColumn: 1, beginLine: 2, endColumn: 32, endLine: 2 },
					},
				],
				wrapProbes: [
					wrap({ armIndex: 1, beginColumn: 24, branchIndex: 1, endColumn: 25, line: 2 }),
					wrap({ armIndex: 2, beginColumn: 31, branchIndex: 1, endColumn: 32, line: 2 }),
				],
			};

			const result = insert({
				fileKey: 'path\\to"\n\r\0file.luau',
				result: collector,
				source,
			});

			expect(result).toStartWith("--!strict\n");
			expect(result).toMatchSnapshot();
		});

		it("should hoist every leading mode directive above the preamble", () => {
			expect.assertions(2);

			const directives = "--!strict\n--!native\n--!optimize 2\n";
			const result = insert({
				fileKey: "test.luau",
				result: emptyResult(),
				source: `${directives}local x = 1`,
			});

			expect(result).toStartWith(directives);
			// Below the preamble a directive no longer opens the file, so
			// Luau stops reading it however it is spaced.
			expect(result.slice(directives.length)).not.toContain("--!");
		});

		it("should keep hoisting past a directive Luau does not act on", () => {
			expect.assertions(1);

			// Luau reads `--!Native` as a hot comment and ignores it, so the
			// `--!native` behind it still opens the file and still counts.
			const directives = "--!strict\n--!Native\n--!native\n";
			const result = insert({
				fileKey: "test.luau",
				result: emptyResult(),
				source: `${directives}local x = 1`,
			});

			expect(result).toStartWith(directives);
		});

		it("should keep hoisting past a blank line between directives", () => {
			expect.assertions(1);

			const header = "--!strict\n\n--!native\n";
			const result = insert({
				fileKey: "test.luau",
				result: emptyResult(),
				source: `${header}local x = 1`,
			});

			expect(result).toStartWith(header);
		});

		it("should keep hoisting past a plain comment between directives", () => {
			expect.assertions(2);

			const lineCommented = "--!strict\n-- why native\n--!native\n";
			const blockCommented = "--!strict\n--[[ why\nnative ]]\n--!native\n";

			expect(
				insert({
					fileKey: "test.luau",
					result: emptyResult(),
					source: `${lineCommented}local x = 1`,
				}),
			).toStartWith(lineCommented);
			expect(
				insert({
					fileKey: "test.luau",
					result: emptyResult(),
					source: `${blockCommented}local x = 1`,
				}),
			).toStartWith(blockCommented);
		});

		it("should hoist a directive that carries leading whitespace", () => {
			expect.assertions(1);

			const header = "--!strict\n\t--!native\n";
			const result = insert({
				fileKey: "test.luau",
				result: emptyResult(),
				source: `${header}local x = 1`,
			});

			expect(result).toStartWith(header);
		});

		it("should keep code below the preamble when a bare return splits a line", () => {
			expect.assertions(1);

			const collector: CollectorResult<LuauSpan> = {
				...emptyResult(),
				statements: [
					{
						index: 1,
						location: { beginColumn: 11, beginLine: 1, endColumn: 22, endLine: 1 },
					},
				],
			};

			// Luau ends the comment at the `\r` and calls what follows code, so
			// hoisting the whole line would put `__cov_s[1]` above its own table.
			const result = insert({
				fileKey: "test.luau",
				result: collector,
				source: "--!strict\rlocal x = 1",
			});

			expect(result).toStartWith("if _G.__jest_roblox_cov");
		});

		it("should only treat a leading mode directive as a directive", () => {
			expect.assertions(1);

			expect(
				insert({
					fileKey: "test.luau",
					result: emptyResult(),
					source: "local x = '--!strict'",
				}),
			).toEndWith("local x = '--!strict'");
		});

		it("should insert statement probes before each statement", () => {
			expect.assertions(3);

			const source = "local x = 1\nprint(x)";
			const collector = twoStatementResult();

			const result = insert({ fileKey: "test.luau", result: collector, source });

			expect(result).toContain("__cov_s[1] += 1; local x = 1");
			expect(result).toContain("__cov_s[2] += 1; print(x)");
			expect(result).toContain("for __i = 1, 2 do");
		});

		it("should insert function probes at body first statement", () => {
			expect.assertions(2);

			const source = "local function greet(name)\n    return name\nend";
			const collector: CollectorResult<LuauSpan> = {
				...emptyResult(),
				functions: [
					{
						name: "greet",
						bodyFirstColumn: 5,
						bodyFirstLine: 2,
						index: 1,
						location: { beginColumn: 1, beginLine: 1, endColumn: 4, endLine: 3 },
					},
				],
				statements: [
					{
						index: 1,
						location: { beginColumn: 1, beginLine: 1, endColumn: 4, endLine: 3 },
					},
					{
						index: 2,
						location: { beginColumn: 5, beginLine: 2, endColumn: 16, endLine: 2 },
					},
				],
			};

			const result = insert({ fileKey: "test.luau", result: collector, source });

			expect(result).toContain("__cov_f[1] += 1;");
			expect(result).toContain("__cov_f");
		});

		it("should insert branch probes at arm body first statements", () => {
			expect.assertions(4);

			const source = "if true then\n    local a = 1\nelse\n    local b = 2\nend";
			const collector: CollectorResult<LuauSpan> = {
				...emptyResult(),
				branches: [
					{
						arms: [
							{
								bodyFirstColumn: 5,
								bodyFirstLine: 2,
								location: {
									beginColumn: 13,
									beginLine: 1,
									endColumn: 1,
									endLine: 3,
								},
							},
							{
								bodyFirstColumn: 5,
								bodyFirstLine: 4,
								location: {
									beginColumn: 5,
									beginLine: 3,
									endColumn: 1,
									endLine: 5,
								},
							},
						],
						branchType: "if",
						index: 1,
					},
				],
				statements: [
					{
						index: 1,
						location: { beginColumn: 1, beginLine: 1, endColumn: 4, endLine: 5 },
					},
					{
						index: 2,
						location: { beginColumn: 5, beginLine: 2, endColumn: 16, endLine: 2 },
					},
					{
						index: 3,
						location: { beginColumn: 5, beginLine: 4, endColumn: 16, endLine: 4 },
					},
				],
			};

			const result = insert({ fileKey: "test.luau", result: collector, source });

			expect(result).toContain("__cov_b[1][1] += 1;");
			expect(result).toContain("__cov_b[1][2] += 1;");
			expect(result).toContain("__cov_b[1] = {0, 0}");
			// The generated Luau is executable instrumentation, so keep its exact
			// shape stable while the assertions document the important pieces.
			expect(result).toMatchSnapshot();
		});

		it("should insert implicit else probes before end keyword", () => {
			expect.assertions(1);

			const source = "if true then\n  local y = 2\nend";
			const collector: CollectorResult<LuauSpan> = {
				...emptyResult(),
				branches: [
					{
						arms: [
							{
								bodyFirstColumn: 3,
								bodyFirstLine: 2,
								location: {
									beginColumn: 13,
									beginLine: 1,
									endColumn: 1,
									endLine: 3,
								},
							},
							{
								bodyFirstColumn: 0,
								bodyFirstLine: 0,
								location: {
									beginColumn: 1,
									beginLine: 1,
									endColumn: 1,
									endLine: 1,
								},
							},
						],
						branchType: "if",
						index: 1,
					},
				],
				implicitElseProbes: [{ armIndex: 2, branchIndex: 1, endColumn: 1, endLine: 3 }],
				statements: [
					{
						index: 1,
						location: { beginColumn: 1, beginLine: 1, endColumn: 4, endLine: 3 },
					},
					{
						index: 2,
						location: { beginColumn: 3, beginLine: 2, endColumn: 14, endLine: 2 },
					},
				],
			};

			const result = insert({ fileKey: "test.luau", result: collector, source });

			expect(result).toContain("else __cov_b[1][2] += 1 end");
		});

		it("should preserve mode directive at top of file", () => {
			expect.assertions(2);

			const source = "--!strict\nlocal x = 1";
			const collector: CollectorResult<LuauSpan> = {
				...emptyResult(),
				statements: [
					{
						index: 1,
						location: { beginColumn: 1, beginLine: 2, endColumn: 12, endLine: 2 },
					},
				],
			};

			const result = insert({ fileKey: "test.luau", result: collector, source });

			expect(result).toMatch(/^--!strict\n/);
			expect(result).toContain("__cov_s[1] += 1; local x = 1");
		});

		it("should escape backslashes and quotes in file key", () => {
			expect.assertions(1);

			const source = "local x = 1";
			const collector = singleStatementResult();

			const result = insert({
				fileKey: 'path\\to\\"file".luau',
				result: collector,
				source,
			});

			expect(result).toContain('__cov_file_key = "path\\\\to\\\\\\"file\\".luau"');
		});

		it("should insert function probe in empty body using body start position", () => {
			expect.assertions(1);

			const source = "local function noop() end";
			const collector = noopFunctionResult({ bodyFirstColumn: 23, bodyFirstLine: 1 });

			const result = insert({ fileKey: "test.luau", result: collector, source });

			expect(result).toContain("__cov_f[1] += 1;");
		});

		it("should skip function probe when bodyFirstLine is zero", () => {
			expect.assertions(1);

			const source = "local function noop() end";
			const collector = noopFunctionResult({ bodyFirstColumn: 0, bodyFirstLine: 0 });

			const result = insert({ fileKey: "test.luau", result: collector, source });

			expect(result).not.toContain("__cov_f[1] += 1");
		});

		it("should wrap expr-if arms with __cov_br helper", () => {
			expect.assertions(3);

			// local x = if true then 1 else 2
			// columns:  1234567890123456789012345678901234
			const source = "local x = if true then 1 else 2";
			const collector: CollectorResult<LuauSpan> = {
				...emptyResult(),
				branches: [
					{
						arms: [
							{
								bodyFirstColumn: 0,
								bodyFirstLine: 0,
								location: {
									beginColumn: 24,
									beginLine: 1,
									endColumn: 25,
									endLine: 1,
								},
							},
							{
								bodyFirstColumn: 0,
								bodyFirstLine: 0,
								location: {
									beginColumn: 31,
									beginLine: 1,
									endColumn: 32,
									endLine: 1,
								},
							},
						],
						branchType: "expr-if",
						index: 1,
					},
				],
				statements: [
					{
						index: 1,
						location: { beginColumn: 1, beginLine: 1, endColumn: 32, endLine: 1 },
					},
				],
				wrapProbes: [
					{
						armIndex: 1,
						branchIndex: 1,
						exprLocation: { beginColumn: 24, beginLine: 1, endColumn: 25, endLine: 1 },
					},
					{
						armIndex: 2,
						branchIndex: 1,
						exprLocation: { beginColumn: 31, beginLine: 1, endColumn: 32, endLine: 1 },
					},
				],
			};

			const result = insert({ fileKey: "test.luau", result: collector, source });

			expect(result).toContain("__cov_br(1, 1, 1)");
			expect(result).toContain("__cov_br(1, 2, 2)");
			expect(result).toContain("local function __cov_br(__bi, __ai, ...)");
		});

		it("should wrap all arms of expr-if with elseif", () => {
			expect.assertions(3);

			// local x = if a then 1 elseif b then 2 else 3
			const source = "local x = if a then 1 elseif b then 2 else 3";
			const collector: CollectorResult<LuauSpan> = {
				...emptyResult(),
				branches: [
					{
						arms: [
							{
								bodyFirstColumn: 0,
								bodyFirstLine: 0,
								location: {
									beginColumn: 21,
									beginLine: 1,
									endColumn: 22,
									endLine: 1,
								},
							},
							{
								bodyFirstColumn: 0,
								bodyFirstLine: 0,
								location: {
									beginColumn: 37,
									beginLine: 1,
									endColumn: 38,
									endLine: 1,
								},
							},
							{
								bodyFirstColumn: 0,
								bodyFirstLine: 0,
								location: {
									beginColumn: 44,
									beginLine: 1,
									endColumn: 45,
									endLine: 1,
								},
							},
						],
						branchType: "expr-if",
						index: 1,
					},
				],
				statements: [
					{
						index: 1,
						location: { beginColumn: 1, beginLine: 1, endColumn: 45, endLine: 1 },
					},
				],
				wrapProbes: [
					{
						armIndex: 1,
						branchIndex: 1,
						exprLocation: { beginColumn: 21, beginLine: 1, endColumn: 22, endLine: 1 },
					},
					{
						armIndex: 2,
						branchIndex: 1,
						exprLocation: { beginColumn: 37, beginLine: 1, endColumn: 38, endLine: 1 },
					},
					{
						armIndex: 3,
						branchIndex: 1,
						exprLocation: { beginColumn: 44, beginLine: 1, endColumn: 45, endLine: 1 },
					},
				],
			};

			const result = insert({ fileKey: "test.luau", result: collector, source });

			expect(result).toContain("__cov_br(1, 1, 1)");
			expect(result).toContain("__cov_br(1, 2, 2)");
			expect(result).toContain("__cov_br(1, 3, 3)");
		});

		it("should nest and/or wraps so outer wraps surround inner wraps", () => {
			expect.assertions(1);

			// `local v = a and b and c` parses as `(a and b) and c`. The outer
			// node's lhs span (`a and b`) and the inner node's lhs span (`a`)
			// both start at column 11; their closes both land at column 18. The
			// inserter must order the colliding wraps so the outer wrap fully
			// surrounds the inner one.
			// columns:        1234567890123456789012345
			const source = "local v = a and b and c";
			const collector: CollectorResult<LuauSpan> = {
				...emptyResult(),
				branches: [
					{
						arms: [
							binaryArm({ beginColumn: 11, endColumn: 18 }),
							binaryArm({ beginColumn: 23, endColumn: 24 }),
						],
						branchType: "binary-expr",
						index: 1,
					},
					{
						arms: [
							binaryArm({ beginColumn: 11, endColumn: 12 }),
							binaryArm({ beginColumn: 17, endColumn: 18 }),
						],
						branchType: "binary-expr",
						index: 2,
					},
				],
				statements: [
					{
						index: 1,
						location: { beginColumn: 1, beginLine: 1, endColumn: 24, endLine: 1 },
					},
				],
				wrapProbes: [
					wrap({ armIndex: 1, beginColumn: 11, branchIndex: 1, endColumn: 18 }),
					wrap({ armIndex: 2, beginColumn: 23, branchIndex: 1, endColumn: 24 }),
					wrap({ armIndex: 1, beginColumn: 11, branchIndex: 2, endColumn: 12 }),
					wrap({ armIndex: 2, beginColumn: 17, branchIndex: 2, endColumn: 18 }),
				],
			};

			const result = insert({ fileKey: "test.luau", result: collector, source });

			expect(result).toContain(
				"__cov_br(1, 1, __cov_br(2, 1, a) and __cov_br(2, 2, b)) and __cov_br(1, 2, c)",
			);
		});

		it("should nest wraps whose colliding opens close on different lines", () => {
			expect.assertions(1);

			// `local v = a\n\tand b and c` parses as `(a and b) and c`. The outer
			// node's lhs operand (`a and b`) spans lines 1-2 while the inner `a`
			// operand is line 1 only; both opens land at line 1 column 11 but
			// their closes are on different lines, so ordering falls to the
			// line component of the wrap's far end.
			const source = "local v = a\n\tand b and c";
			const collector: CollectorResult<LuauSpan> = {
				...emptyResult(),
				branches: [
					{
						arms: [
							binaryArm({ beginColumn: 11, endColumn: 12 }),
							binaryArm({ beginColumn: 12, endColumn: 13 }),
						],
						branchType: "binary-expr",
						index: 1,
					},
					{
						arms: [
							binaryArm({ beginColumn: 11, endColumn: 12 }),
							binaryArm({ beginColumn: 6, endColumn: 7 }),
						],
						branchType: "binary-expr",
						index: 2,
					},
				],
				statements: [
					{
						index: 1,
						location: { beginColumn: 1, beginLine: 1, endColumn: 13, endLine: 2 },
					},
				],
				wrapProbes: [
					// outer lhs `a and b`: line 1 col 11 → line 2 col 7
					{
						armIndex: 1,
						branchIndex: 1,
						exprLocation: { beginColumn: 11, beginLine: 1, endColumn: 7, endLine: 2 },
					},
					// outer rhs `c`: line 2
					{
						armIndex: 2,
						branchIndex: 1,
						exprLocation: { beginColumn: 12, beginLine: 2, endColumn: 13, endLine: 2 },
					},
					// inner lhs `a`: line 1 col 11 → col 12
					{
						armIndex: 1,
						branchIndex: 2,
						exprLocation: { beginColumn: 11, beginLine: 1, endColumn: 12, endLine: 1 },
					},
					// inner rhs `b`: line 2
					{
						armIndex: 2,
						branchIndex: 2,
						exprLocation: { beginColumn: 6, beginLine: 2, endColumn: 7, endLine: 2 },
					},
				],
			};

			const result = insert({ fileKey: "test.luau", result: collector, source });

			// The outer open stays outside the inner open on line 1.
			expect(result).toContain("local v = __cov_br(1, 1, __cov_br(2, 1, a)");
		});

		it("should keep a point probe outside a wrap opening at the same column", () => {
			expect.assertions(1);

			// A statement bump and a wrap open landing on the same column: the
			// bump stays to the left of (outside) the wrap.
			const source = "0000000000ab";
			const collector: CollectorResult<LuauSpan> = {
				...emptyResult(),
				branches: [
					{
						arms: [
							binaryArm({ beginColumn: 11, endColumn: 12 }),
							binaryArm({ beginColumn: 13, endColumn: 14 }),
						],
						branchType: "binary-expr",
						index: 1,
					},
				],
				statements: [
					{
						index: 1,
						location: { beginColumn: 11, beginLine: 1, endColumn: 13, endLine: 1 },
					},
				],
				wrapProbes: [wrap({ armIndex: 1, beginColumn: 11, branchIndex: 1, endColumn: 12 })],
			};

			const result = insert({ fileKey: "test.luau", result: collector, source });

			expect(result.indexOf("__cov_s[1]")).toBeLessThan(result.indexOf("__cov_br(1, 1,"));
		});

		it("should not emit __cov_br helper when no wrap probes exist", () => {
			expect.assertions(1);

			const source = "local x = 1";
			const collector = singleStatementResult();

			const result = insert({ fileKey: "test.luau", result: collector, source });

			expect(result).not.toContain("__cov_br");
		});

		it("should add space when branch probe follows non-whitespace", () => {
			expect.assertions(1);

			const source = "if x then\n    -- comment\nend";
			const collector: CollectorResult<LuauSpan> = {
				...emptyResult(),
				branches: [
					{
						arms: [
							{
								bodyFirstColumn: 10,
								bodyFirstLine: 1,
								location: {
									beginColumn: 10,
									beginLine: 1,
									endColumn: 1,
									endLine: 3,
								},
							},
						],
						branchType: "if",
						index: 1,
					},
				],
				statements: [
					{
						index: 1,
						location: { beginColumn: 1, beginLine: 1, endColumn: 4, endLine: 3 },
					},
				],
			};

			const result = insert({ fileKey: "test.luau", result: collector, source });

			expect(result).toContain("if x then __cov_b[1][1] += 1;");
		});

		it("should handle CRLF line endings", () => {
			expect.assertions(1);

			const source = "local x = 1\r\nprint(x)";
			const collector = twoStatementResult();

			const result = insert({ fileKey: "test.luau", result: collector, source });

			expect(result).toEndWith("__cov_s[1] += 1; local x = 1\n__cov_s[2] += 1; print(x)");
		});
	});
});

function instrumentFixture(name: string, fileKey = name): string {
	const { result, source } = COLLECTED_FIXTURES[name]!;
	return insertProbes({ fileKey, result, source });
}

describe("probes in collected fixtures", () => {
	it.for([
		"simple.luau",
		"empty.luau",
		"if-only.luau",
		"functions.luau",
		"if-else.luau",
		"expr-if.luau",
		"and-or.luau",
	])("should produce the expected instrumented source for %s", (name) => {
		expect.assertions(1);

		expect(instrumentFixture(name)).toMatchSnapshot();
	});

	it("should key the preamble on the file key", () => {
		expect.assertions(3);

		const instrumented = instrumentFixture("simple.luau", "shared/simple.luau");

		expect(instrumented).toContain('__cov_file_key = "shared/simple.luau"');
		expect(instrumented).toContain("_G.__jest_roblox_cov");
		expect(instrumented).toContain("__cov_s");
	});

	it("should count function entry inside the body", () => {
		expect.assertions(1);

		expect(instrumentFixture("functions.luau")).toContain("__cov_f[1] += 1;");
	});

	it("should probe every if/elseif/else arm and size the preamble to match", () => {
		expect.assertions(4);

		const instrumented = instrumentFixture("if-else.luau");

		expect(instrumented).toContain("__cov_b[1][1] += 1;");
		expect(instrumented).toContain("__cov_b[1][2] += 1;");
		expect(instrumented).toContain("__cov_b[1][3] += 1;");
		expect(instrumented).toContain("__cov_b[1] = {0, 0, 0}");
	});

	it("should not point-probe an expression-if", () => {
		expect.assertions(1);

		expect(instrumentFixture("expr-if.luau")).not.toContain("__cov_b[1][1] += 1");
	});

	it("should wrap and/or operands, outer wraps around inner", () => {
		expect.assertions(3);

		const instrumented = instrumentFixture("and-or.luau");

		expect(instrumented).toContain("local a = __cov_br(1, 1, x) and __cov_br(1, 2, y)");
		expect(instrumented).toContain("local b = __cov_br(2, 1, p) or __cov_br(2, 2, q)");
		expect(instrumented).toContain(
			"local c = __cov_br(3, 1, __cov_br(4, 1, i) and __cov_br(4, 2, j)) and __cov_br(3, 2, k)",
		);
	});

	it("should place probes at character boundaries on multi-byte lines", () => {
		expect.assertions(4);

		const instrumented = instrumentFixture("utf8-columns.luau");

		expect(instrumented).toContain(
			'local heart = if true then __cov_br(1, 1, `❤️ {1}`) else __cov_br(1, 2, "none")',
		);
		expect(instrumented).toContain(
			'local infinity = __cov_br(2, 1, "∞") or __cov_br(2, 2, "fallback")',
		);
		expect(instrumented).toContain(
			'local price = __cov_br(3, 1, `\u{E002}{100}`) and __cov_br(3, 2, "free")',
		);
		expect(instrumented).toContain(
			'local party = __cov_br(4, 1, "\u{1F389}") and __cov_br(4, 2, "yes")',
		);
	});

	it.for(Object.keys(COLLECTED_FIXTURES))(
		"should keep %s line-for-line aligned with its original",
		(name) => {
			expect.assertions(1);

			const { source } = COLLECTED_FIXTURES[name]!;
			const originalLineCount = source.replace(/\r?\n$/u, "").split(/\r?\n/u).length;

			expect(instrumentFixture(name).split("\n")).toHaveLength(originalLineCount);
		},
	);
});
