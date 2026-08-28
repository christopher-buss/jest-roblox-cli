import { describe, expect, it } from "vitest";

import type { CollectorResult } from "./coverage-collector.ts";
import { insertProbes } from "./probe-inserter.ts";

function emptyResult(): CollectorResult {
	return {
		branches: [],
		functions: [],
		implicitElseProbes: [],
		statements: [],
		wrapProbes: [],
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
}): CollectorResult["branches"][number]["arms"][number] {
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
}): CollectorResult["wrapProbes"][number] {
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

			expect(insertProbes("--!strict\n", emptyResult(), "test.luau")).toBe("--!strict\n");
			expect(insertProbes("--!strict\n--!native\n", emptyResult(), "test.luau")).toBe(
				"--!strict\n--!native\n",
			);
			expect(insertProbes("-- one\n-- two\n", emptyResult(), "test.luau")).toBe(
				"-- one\n-- two",
			);
		});

		it("should declare the function bucket for a file whose only sites are functions", () => {
			expect.assertions(3);

			const collector: CollectorResult = {
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

			const result = insertProbes("local function f()\nend", collector, "test.luau");

			expect(result).toContain("local __cov_f =");
			expect(result).toContain("for __i = 1, 1 do if __cov_f");
			expect(result).not.toContain("__cov_s[__i]");
		});

		it("should declare the branch bucket for a file whose only sites are branches", () => {
			expect.assertions(2);

			const collector: CollectorResult = {
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

			const result = insertProbes("local x = a or b", collector, "test.luau");

			expect(result).toContain("local __cov_b =");
			expect(result).not.toContain("__cov_s[__i]");
		});

		// The one case no fixture in `test/fixtures/coverage-pipeline` covers:
		// a leading mode directive, which the fold has to skip past. The branch
		// count is what used to grow the shift, so it varies here too.
		it("should keep every original line at its original line number", () => {
			expect.assertions(2);

			const source = '--!strict\nlocal a = 1\nlocal b = 2\nerror("boom")';
			const collector: CollectorResult = {
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

			const result = insertProbes(source, collector, "test.luau");

			const lines = result.split("\n");

			expect(lines).toHaveLength(4);
			expect(lines[3]).toBe('error("boom")');
		});

		it("should declare only the buckets the file's sites need", () => {
			expect.assertions(5);

			const source = "local x = 1";
			const collector: CollectorResult = {
				...emptyResult(),
				statements: [
					{
						index: 1,
						location: { beginColumn: 1, beginLine: 1, endColumn: 12, endLine: 1 },
					},
				],
			};

			const result = insertProbes(source, collector, "test.luau");

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
			const collector: CollectorResult = {
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

			const result = insertProbes(source, collector, 'path\\to"\n\r\0file.luau');

			expect(result).toStartWith("--!strict\n");
			expect(result).toMatchSnapshot();
		});

		it("should hoist every leading mode directive above the preamble", () => {
			expect.assertions(2);

			const directives = "--!strict\n--!native\n--!optimize 2\n";
			const result = insertProbes(`${directives}local x = 1`, emptyResult(), "test.luau");

			expect(result).toStartWith(directives);
			// Below the preamble a directive no longer opens the file, so
			// Luau stops reading it however it is spaced.
			expect(result.slice(directives.length)).not.toContain("--!");
		});

		it("should only treat a leading mode directive as a directive", () => {
			expect.assertions(1);

			expect(insertProbes("local x = '--!strict'", emptyResult(), "test.luau")).toEndWith(
				"local x = '--!strict'",
			);
		});

		it("should insert statement probes before each statement", () => {
			expect.assertions(3);

			const source = "local x = 1\nprint(x)";
			const collector: CollectorResult = {
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

			const result = insertProbes(source, collector, "test.luau");

			expect(result).toContain("__cov_s[1] += 1; local x = 1");
			expect(result).toContain("__cov_s[2] += 1; print(x)");
			expect(result).toContain("for __i = 1, 2 do");
		});

		it("should insert function probes at body first statement", () => {
			expect.assertions(2);

			const source = "local function greet(name)\n    return name\nend";
			const collector: CollectorResult = {
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

			const result = insertProbes(source, collector, "test.luau");

			expect(result).toContain("__cov_f[1] += 1;");
			expect(result).toContain("__cov_f");
		});

		it("should insert branch probes at arm body first statements", () => {
			expect.assertions(4);

			const source = "if true then\n    local a = 1\nelse\n    local b = 2\nend";
			const collector: CollectorResult = {
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

			const result = insertProbes(source, collector, "test.luau");

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
			const collector: CollectorResult = {
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

			const result = insertProbes(source, collector, "test.luau");

			expect(result).toContain("else __cov_b[1][2] += 1 end");
		});

		it("should preserve mode directive at top of file", () => {
			expect.assertions(2);

			const source = "--!strict\nlocal x = 1";
			const collector: CollectorResult = {
				...emptyResult(),
				statements: [
					{
						index: 1,
						location: { beginColumn: 1, beginLine: 2, endColumn: 12, endLine: 2 },
					},
				],
			};

			const result = insertProbes(source, collector, "test.luau");

			expect(result).toMatch(/^--!strict\n/);
			expect(result).toContain("__cov_s[1] += 1; local x = 1");
		});

		it("should escape backslashes and quotes in file key", () => {
			expect.assertions(1);

			const source = "local x = 1";
			const collector: CollectorResult = {
				...emptyResult(),
				statements: [
					{
						index: 1,
						location: { beginColumn: 1, beginLine: 1, endColumn: 12, endLine: 1 },
					},
				],
			};

			const result = insertProbes(source, collector, 'path\\to\\"file".luau');

			expect(result).toContain('__cov_file_key = "path\\\\to\\\\\\"file\\".luau"');
		});

		it("should insert function probe in empty body using body start position", () => {
			expect.assertions(1);

			const source = "local function noop() end";
			const collector: CollectorResult = {
				...emptyResult(),
				functions: [
					{
						name: "noop",
						bodyFirstColumn: 23,
						bodyFirstLine: 1,
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

			const result = insertProbes(source, collector, "test.luau");

			expect(result).toContain("__cov_f[1] += 1;");
		});

		it("should skip function probe when bodyFirstLine is zero", () => {
			expect.assertions(1);

			const source = "local function noop() end";
			const collector: CollectorResult = {
				...emptyResult(),
				functions: [
					{
						name: "noop",
						bodyFirstColumn: 0,
						bodyFirstLine: 0,
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

			const result = insertProbes(source, collector, "test.luau");

			expect(result).not.toContain("__cov_f[1] += 1");
		});

		it("should wrap expr-if arms with __cov_br helper", () => {
			expect.assertions(3);

			// local x = if true then 1 else 2
			// columns:  1234567890123456789012345678901234
			const source = "local x = if true then 1 else 2";
			const collector: CollectorResult = {
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

			const result = insertProbes(source, collector, "test.luau");

			expect(result).toContain("__cov_br(1, 1, 1)");
			expect(result).toContain("__cov_br(1, 2, 2)");
			expect(result).toContain("local function __cov_br(__bi, __ai, ...)");
		});

		it("should wrap all arms of expr-if with elseif", () => {
			expect.assertions(3);

			// local x = if a then 1 elseif b then 2 else 3
			const source = "local x = if a then 1 elseif b then 2 else 3";
			const collector: CollectorResult = {
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

			const result = insertProbes(source, collector, "test.luau");

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
			const collector: CollectorResult = {
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

			const result = insertProbes(source, collector, "test.luau");

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
			const collector: CollectorResult = {
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

			const result = insertProbes(source, collector, "test.luau");

			// The outer open stays outside the inner open on line 1.
			expect(result).toContain("local v = __cov_br(1, 1, __cov_br(2, 1, a)");
		});

		it("should keep a point probe outside a wrap opening at the same column", () => {
			expect.assertions(1);

			// A statement bump and a wrap open landing on the same column: the
			// bump stays to the left of (outside) the wrap.
			const source = "0000000000ab";
			const collector: CollectorResult = {
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

			const result = insertProbes(source, collector, "test.luau");

			expect(result.indexOf("__cov_s[1]")).toBeLessThan(result.indexOf("__cov_br(1, 1,"));
		});

		it("should not emit __cov_br helper when no wrap probes exist", () => {
			expect.assertions(1);

			const source = "local x = 1";
			const collector: CollectorResult = {
				...emptyResult(),
				statements: [
					{
						index: 1,
						location: { beginColumn: 1, beginLine: 1, endColumn: 12, endLine: 1 },
					},
				],
			};

			const result = insertProbes(source, collector, "test.luau");

			expect(result).not.toContain("__cov_br");
		});

		it("should add space when branch probe follows non-whitespace", () => {
			expect.assertions(1);

			const source = "if x then\n    -- comment\nend";
			const collector: CollectorResult = {
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

			const result = insertProbes(source, collector, "test.luau");

			expect(result).toContain("if x then __cov_b[1][1] += 1;");
		});

		it("should handle CRLF line endings", () => {
			expect.assertions(1);

			const source = "local x = 1\r\nprint(x)";
			const collector: CollectorResult = {
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

			const result = insertProbes(source, collector, "test.luau");

			expect(result).toEndWith("__cov_s[1] += 1; local x = 1\n__cov_s[2] += 1; print(x)");
		});
	});
});
