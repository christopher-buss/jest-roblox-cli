import { describe, expect, it } from "vitest";

import type { CollectorResult } from "./coverage-collector.ts";
import { insertProbes } from "./probe-inserter.ts";

function emptyResult(): CollectorResult {
	return {
		branches: [],
		exprIfProbes: [],
		functions: [],
		implicitElseProbes: [],
		statements: [],
	};
}

describe("probe-inserter", () => {
	describe(insertProbes, () => {
		it("should return preamble-only for empty result", () => {
			expect.assertions(3);

			const source = "";
			const result = insertProbes(source, emptyResult(), "test.luau");

			expect(result).toContain("_G.__jest_roblox_cov");
			expect(result).toContain('__cov_file_key = "test.luau"');
			expect(result).not.toContain("for __i = 1,");
		});

		it("should insert statement probes before each statement", () => {
			expect.assertions(3);

			const source = "local x = 1\nprint(x)";
			const collector: CollectorResult = {
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
						location: { begincolumn: 1, beginline: 1, endcolumn: 4, endline: 3 },
					},
				],
				statements: [
					{
						index: 1,
						location: { begincolumn: 1, beginline: 1, endcolumn: 4, endline: 3 },
					},
					{
						index: 2,
						location: { begincolumn: 5, beginline: 2, endcolumn: 16, endline: 2 },
					},
				],
			};

			const result = insertProbes(source, collector, "test.luau");

			expect(result).toContain("__cov_f[1] += 1;");
			expect(result).toContain("__cov_f");
		});

		it("should insert branch probes at arm body first statements", () => {
			expect.assertions(3);

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
				statements: [
					{
						index: 1,
						location: { begincolumn: 1, beginline: 1, endcolumn: 4, endline: 5 },
					},
					{
						index: 2,
						location: { begincolumn: 5, beginline: 2, endcolumn: 16, endline: 2 },
					},
					{
						index: 3,
						location: { begincolumn: 5, beginline: 4, endcolumn: 16, endline: 4 },
					},
				],
			};

			const result = insertProbes(source, collector, "test.luau");

			expect(result).toContain("__cov_b[1][1] += 1;");
			expect(result).toContain("__cov_b[1][2] += 1;");
			expect(result).toContain("__cov_b[1] = {0, 0}");
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
									begincolumn: 13,
									beginline: 1,
									endcolumn: 1,
									endline: 3,
								},
							},
							{
								bodyFirstColumn: 0,
								bodyFirstLine: 0,
								location: {
									begincolumn: 1,
									beginline: 1,
									endcolumn: 1,
									endline: 1,
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
						location: { begincolumn: 1, beginline: 1, endcolumn: 4, endline: 3 },
					},
					{
						index: 2,
						location: { begincolumn: 3, beginline: 2, endcolumn: 14, endline: 2 },
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
						location: { begincolumn: 1, beginline: 2, endcolumn: 12, endline: 2 },
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
						location: { begincolumn: 1, beginline: 1, endcolumn: 12, endline: 1 },
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
						location: { begincolumn: 1, beginline: 1, endcolumn: 26, endline: 1 },
					},
				],
				statements: [
					{
						index: 1,
						location: { begincolumn: 1, beginline: 1, endcolumn: 26, endline: 1 },
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
						location: { begincolumn: 1, beginline: 1, endcolumn: 26, endline: 1 },
					},
				],
				statements: [
					{
						index: 1,
						location: { begincolumn: 1, beginline: 1, endcolumn: 26, endline: 1 },
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
									begincolumn: 24,
									beginline: 1,
									endcolumn: 25,
									endline: 1,
								},
							},
							{
								bodyFirstColumn: 0,
								bodyFirstLine: 0,
								location: {
									begincolumn: 31,
									beginline: 1,
									endcolumn: 32,
									endline: 1,
								},
							},
						],
						branchType: "expr-if",
						index: 1,
					},
				],
				exprIfProbes: [
					{
						armIndex: 1,
						branchIndex: 1,
						exprLocation: { begincolumn: 24, beginline: 1, endcolumn: 25, endline: 1 },
					},
					{
						armIndex: 2,
						branchIndex: 1,
						exprLocation: { begincolumn: 31, beginline: 1, endcolumn: 32, endline: 1 },
					},
				],
				statements: [
					{
						index: 1,
						location: { begincolumn: 1, beginline: 1, endcolumn: 32, endline: 1 },
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
									begincolumn: 21,
									beginline: 1,
									endcolumn: 22,
									endline: 1,
								},
							},
							{
								bodyFirstColumn: 0,
								bodyFirstLine: 0,
								location: {
									begincolumn: 37,
									beginline: 1,
									endcolumn: 38,
									endline: 1,
								},
							},
							{
								bodyFirstColumn: 0,
								bodyFirstLine: 0,
								location: {
									begincolumn: 44,
									beginline: 1,
									endcolumn: 45,
									endline: 1,
								},
							},
						],
						branchType: "expr-if",
						index: 1,
					},
				],
				exprIfProbes: [
					{
						armIndex: 1,
						branchIndex: 1,
						exprLocation: { begincolumn: 21, beginline: 1, endcolumn: 22, endline: 1 },
					},
					{
						armIndex: 2,
						branchIndex: 1,
						exprLocation: { begincolumn: 37, beginline: 1, endcolumn: 38, endline: 1 },
					},
					{
						armIndex: 3,
						branchIndex: 1,
						exprLocation: { begincolumn: 44, beginline: 1, endcolumn: 45, endline: 1 },
					},
				],
				statements: [
					{
						index: 1,
						location: { begincolumn: 1, beginline: 1, endcolumn: 45, endline: 1 },
					},
				],
			};

			const result = insertProbes(source, collector, "test.luau");

			expect(result).toContain("__cov_br(1, 1, 1)");
			expect(result).toContain("__cov_br(1, 2, 2)");
			expect(result).toContain("__cov_br(1, 3, 3)");
		});

		it("should not emit __cov_br helper when no expr-if probes exist", () => {
			expect.assertions(1);

			const source = "local x = 1";
			const collector: CollectorResult = {
				...emptyResult(),
				statements: [
					{
						index: 1,
						location: { begincolumn: 1, beginline: 1, endcolumn: 12, endline: 1 },
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
									begincolumn: 10,
									beginline: 1,
									endcolumn: 1,
									endline: 3,
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
						location: { begincolumn: 1, beginline: 1, endcolumn: 4, endline: 3 },
					},
				],
			};

			const result = insertProbes(source, collector, "test.luau");

			expect(result).toContain("if x then __cov_b[1][1] += 1;");
		});

		it("should handle CRLF line endings", () => {
			expect.assertions(2);

			const source = "local x = 1\r\nprint(x)";
			const collector: CollectorResult = {
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
			};

			const result = insertProbes(source, collector, "test.luau");

			expect(result).toContain("__cov_s[1] += 1; local x = 1");
			expect(result).toContain("__cov_s[2] += 1; print(x)");
		});
	});
});
