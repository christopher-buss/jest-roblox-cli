import type { AstStatBlock } from "@isentinel/luau-ast";

import { type } from "arktype";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assert, describe, expect, it } from "vitest";

import { collectCoverage } from "../../src/coverage-pipeline/coverage-collector.ts";
import { buildCoverageMap } from "../../src/coverage-pipeline/coverage-map-builder.ts";
import { insertProbes } from "../../src/coverage-pipeline/probe-inserter.ts";

const PARSE_SCRIPT = path.resolve(import.meta.dirname, "../../src/luau/parse-ast.luau");
const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures/coverage-pipeline");

// Cache the AST map from a single lute call for all fixtures
let cachedAstMap: Record<string, unknown> | undefined;

function getAstMap(): Record<string, unknown> {
	if (cachedAstMap !== undefined) {
		return cachedAstMap;
	}

	const astOutputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cov-ast-"));

	const fileListJson = cp.execFileSync(
		"lute",
		["run", PARSE_SCRIPT, "--", FIXTURES_DIR, astOutputDirectory],
		{ encoding: "utf-8", timeout: 10_000, windowsHide: true },
	);

	const fileList = type("string[]").assert(JSON.parse(fileListJson));
	const astMap: Record<string, unknown> = {};
	for (const relativePath of fileList) {
		const astJsonPath = path.join(astOutputDirectory, `${relativePath}.json`);
		astMap[relativePath] = JSON.parse(fs.readFileSync(astJsonPath, "utf-8"));
	}

	// The parsed AST is now wholly in memory; the scratch dir can go.
	fs.rmSync(astOutputDirectory, { force: true, recursive: true });

	cachedAstMap = astMap;
	return cachedAstMap;
}

function instrumentFixture(fixtureName: string, fileKey: string) {
	const fixturePath = path.join(FIXTURES_DIR, fixtureName);
	const source = fs.readFileSync(fixturePath, "utf-8");

	const astMap = getAstMap();
	const rawAst = astMap[fixtureName];
	assert(rawAst !== undefined, `Fixture ${fixtureName} not found in AST map`);

	const ast = rawAst as AstStatBlock;
	const result = collectCoverage(ast);
	const instrumentedSource = insertProbes(source, result, fileKey);
	const covMap = buildCoverageMap(result);

	return { covMap, instrumentedSource, result };
}

function validateLuauSource(source: string): string {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cov-validate-"));
	const luauFile = path.join(temporaryDirectory, "check.luau");
	fs.writeFileSync(luauFile, source);

	const normalizedPath = luauFile.replaceAll("\\", "/");
	/* cspell:disable */
	const checkScript = [
		'local syntax = require("@std/syntax")',
		'local fs = require("@std/fs")',
		`local source = fs.readFileToString("${normalizedPath}")`,
		"local result = syntax.parse(source)",
		"if result.root and #result.root.statements > 0 then",
		'  print("OK")',
		"else",
		'  print("EMPTY")',
		"end",
	].join("\n");
	const checkFile = path.join(temporaryDirectory, "validate.luau");
	fs.writeFileSync(checkFile, checkScript);

	const output = cp.execFileSync("lute", ["run", checkFile], {
		encoding: "utf-8",
		timeout: 10_000,
		windowsHide: true,
	});

	fs.rmSync(temporaryDirectory, { force: true, recursive: true });

	return output.trim();
}

// Executes instrumented Luau through Lute and returns its stdout. Used to prove
// runtime behavior (short-circuit, value preservation) rather than just shape.
// Lute's real `_G` is readonly, so shadow it with a writable local — the real
// Roblox runtime's `_G` is writable, which is why the preamble targets it.
function runLuau(source: string): string {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cov-run-"));
	const luauFile = path.join(temporaryDirectory, "run.luau");
	fs.writeFileSync(luauFile, `local _G = {}\n${source}`);

	try {
		return cp.execFileSync("lute", ["run", luauFile], {
			encoding: "utf-8",
			timeout: 10_000,
			windowsHide: true,
		});
	} finally {
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });
	}
}

describe("instrumentation pipeline (integration)", () => {
	describe("when instrumenting a simple file", () => {
		it("should produce the expected instrumented source and cov-map", () => {
			expect.assertions(2);

			const { covMap, instrumentedSource } = instrumentFixture("simple.luau", "simple.luau");

			expect(instrumentedSource).toMatchSnapshot("instrumented source");
			expect(covMap).toMatchSnapshot("cov-map");
		});
	});

	describe("when instrumenting an empty file", () => {
		it("should produce the expected instrumented source and cov-map", () => {
			expect.assertions(2);

			const { covMap, instrumentedSource } = instrumentFixture("empty.luau", "empty.luau");

			expect(instrumentedSource).toMatchSnapshot("instrumented source");
			expect(covMap).toMatchSnapshot("cov-map");
		});
	});

	describe("when instrumenting an if statement", () => {
		it("should produce the expected instrumented source and cov-map", () => {
			expect.assertions(2);

			const { covMap, instrumentedSource } = instrumentFixture(
				"if-only.luau",
				"if-only.luau",
			);

			expect(instrumentedSource).toMatchSnapshot("instrumented source");
			expect(covMap).toMatchSnapshot("cov-map");
		});
	});

	describe("when injecting the preamble", () => {
		it("should include the coverage initialization block with the file key", () => {
			expect.assertions(3);

			const { instrumentedSource } = instrumentFixture("simple.luau", "shared/simple.luau");

			expect(instrumentedSource).toContain('__cov_file_key = "shared/simple.luau"');
			expect(instrumentedSource).toContain("_G.__jest_roblox_cov");
			expect(instrumentedSource).toContain("__cov_s");
		});
	});

	describe("when instrumenting functions", () => {
		it("should produce the expected instrumented source and cov-map", () => {
			expect.assertions(2);

			const { covMap, instrumentedSource } = instrumentFixture(
				"functions.luau",
				"functions.luau",
			);

			expect(instrumentedSource).toMatchSnapshot("instrumented source");
			expect(covMap).toMatchSnapshot("cov-map");
		});

		it("should inject __cov_f probes inside function bodies", () => {
			expect.assertions(2);

			const { instrumentedSource } = instrumentFixture("functions.luau", "functions.luau");

			expect(instrumentedSource).toContain("__cov_f");
			expect(instrumentedSource).toContain("__cov_f[1] += 1;");
		});

		it("should include functionMap with correct names in the cov-map", () => {
			expect.assertions(4);

			const { covMap } = instrumentFixture("functions.luau", "functions.luau");

			const functionEntries = Object.values(covMap.functionMap ?? {});

			expect(functionEntries).not.toBeEmpty();
			expect(covMap.functionMap).toBeDefined();

			const functionNames = functionEntries.map((entry) => entry.name);

			expect(functionNames).toContain("greet");
			expect(functionNames).toContain("globalFunc");
		});

		it("should include anonymous function names for function expressions", () => {
			expect.assertions(1);

			const { covMap } = instrumentFixture("functions.luau", "functions.luau");

			const functionNames = Object.values(covMap.functionMap ?? {}).map(
				(entry) => entry.name,
			);

			expect(functionNames).toContain("(anonymous)");
		});

		it("should produce valid Luau that Lute can parse", () => {
			expect.assertions(1);

			const { instrumentedSource } = instrumentFixture("functions.luau", "functions.luau");

			expect(validateLuauSource(instrumentedSource)).toBe("OK");
		});
	});

	describe("when instrumenting if/elseif/else branches", () => {
		it("should inject __cov_b probes at the start of each arm", () => {
			expect.assertions(3);

			const { instrumentedSource } = instrumentFixture("if-else.luau", "if-else.luau");

			expect(instrumentedSource).toContain("__cov_b[1][1] += 1;");
			expect(instrumentedSource).toContain("__cov_b[1][2] += 1;");
			expect(instrumentedSource).toContain("__cov_b[1][3] += 1;");
		});

		it("should include branchMap with correct arm count in the cov-map", () => {
			expect.assertions(3);

			const { covMap } = instrumentFixture("if-else.luau", "if-else.luau");

			const branchEntries = Object.values(covMap.branchMap ?? {});

			expect(branchEntries).toHaveLength(1);
			expect(covMap.branchMap).toBeDefined();
			expect(covMap.branchMap?.["1"]?.locations).toHaveLength(3);
		});

		it("should set branch type to if in the cov-map", () => {
			expect.assertions(1);

			const { covMap } = instrumentFixture("if-else.luau", "if-else.luau");

			expect(covMap.branchMap?.["1"]?.type).toBe("if");
		});

		it("should initialize __cov_b preamble with correct arm counts", () => {
			expect.assertions(2);

			const { instrumentedSource } = instrumentFixture("if-else.luau", "if-else.luau");

			expect(instrumentedSource).toContain("__cov_b");
			expect(instrumentedSource).toContain("__cov_b[1] = {0, 0, 0}");
		});

		it("should produce the expected instrumented source and cov-map", () => {
			expect.assertions(2);

			const { covMap, instrumentedSource } = instrumentFixture(
				"if-else.luau",
				"if-else.luau",
			);

			expect(instrumentedSource).toMatchSnapshot("instrumented source");
			expect(covMap).toMatchSnapshot("cov-map");
		});

		it("should produce valid Luau that Lute can parse", () => {
			expect.assertions(1);

			const { instrumentedSource } = instrumentFixture("if-else.luau", "if-else.luau");

			expect(validateLuauSource(instrumentedSource)).toBe("OK");
		});
	});

	describe("when instrumenting if without else", () => {
		it("should have arms for then block and implicit else", () => {
			expect.assertions(2);

			const { covMap } = instrumentFixture("if-only.luau", "if-only.luau");

			expect(Object.values(covMap.branchMap ?? {})).toHaveLength(1);
			// then arm + implicit else arm
			expect(covMap.branchMap?.["1"]?.locations).toHaveLength(2);
		});
	});

	describe("when instrumenting expression-if branches", () => {
		it("should include branchMap entries with type expr-if", () => {
			expect.assertions(3);

			const { covMap } = instrumentFixture("expr-if.luau", "expr-if.luau");

			const branchEntries = Object.values(covMap.branchMap ?? {});

			expect(branchEntries.length).toBeGreaterThanOrEqual(2);
			expect(covMap.branchMap).toBeDefined();

			const types = branchEntries.map((e) => e.type);

			expect(types).toContain("expr-if");
		});

		it("should record correct arm count for simple expression-if", () => {
			expect.assertions(1);

			const { covMap } = instrumentFixture("expr-if.luau", "expr-if.luau");

			expect(covMap.branchMap?.["1"]?.locations).toHaveLength(2);
		});

		it("should record correct arm count for expression-if with elseif", () => {
			expect.assertions(1);

			const { covMap } = instrumentFixture("expr-if.luau", "expr-if.luau");

			expect(covMap.branchMap?.["2"]?.locations).toHaveLength(3);
		});

		it("should not inject runtime probes for expression-if", () => {
			expect.assertions(1);

			const { instrumentedSource } = instrumentFixture("expr-if.luau", "expr-if.luau");

			expect(instrumentedSource).not.toContain("__cov_b[1][1] += 1");
		});

		it("should produce valid Luau that Lute can parse", () => {
			expect.assertions(1);

			const { instrumentedSource } = instrumentFixture("expr-if.luau", "expr-if.luau");

			expect(validateLuauSource(instrumentedSource)).toBe("OK");
		});

		it("should produce the expected instrumented source and cov-map", () => {
			expect.assertions(2);

			const { covMap, instrumentedSource } = instrumentFixture(
				"expr-if.luau",
				"expr-if.luau",
			);

			expect(instrumentedSource).toMatchSnapshot("instrumented source");
			expect(covMap).toMatchSnapshot("cov-map");
		});
	});

	describe("when instrumenting and/or branches", () => {
		it("should record each and/or as a binary-expr branch in the cov-map", () => {
			expect.assertions(3);

			const { covMap } = instrumentFixture("and-or.luau", "and-or.luau");

			const branchEntries = Object.values(covMap.branchMap ?? {});

			// `x and y`, `p or q`, and `i and j and k` (two nested nodes) = 4.
			expect(branchEntries).toHaveLength(4);
			expect(branchEntries.every((entry) => entry.type === "binary-expr")).toBeTrue();
			expect(branchEntries.every((entry) => entry.locations.length === 2)).toBeTrue();
		});

		it("should wrap operands with the __cov_br helper", () => {
			expect.assertions(2);

			const { instrumentedSource } = instrumentFixture("and-or.luau", "and-or.luau");

			expect(instrumentedSource).toContain(
				"local a = __cov_br(1, 1, x) and __cov_br(1, 2, y)",
			);
			expect(instrumentedSource).toContain(
				"local b = __cov_br(2, 1, p) or __cov_br(2, 2, q)",
			);
		});

		it("should nest a left-associative chain so outer wraps surround inner", () => {
			expect.assertions(1);

			const { instrumentedSource } = instrumentFixture("and-or.luau", "and-or.luau");

			// `i and j and k` → `(i and j) and k`: branch 3 is the outer node,
			// branch 4 the inner `i and j`.
			expect(instrumentedSource).toContain(
				"local c = __cov_br(3, 1, __cov_br(4, 1, i) and __cov_br(4, 2, j)) and __cov_br(3, 2, k)",
			);
		});

		it("should produce valid Luau that Lute can parse", () => {
			expect.assertions(1);

			const { instrumentedSource } = instrumentFixture("and-or.luau", "and-or.luau");

			expect(validateLuauSource(instrumentedSource)).toBe("OK");
		});

		it("should produce the expected instrumented source and cov-map", () => {
			expect.assertions(2);

			const { covMap, instrumentedSource } = instrumentFixture("and-or.luau", "and-or.luau");

			expect(instrumentedSource).toMatchSnapshot("instrumented source");
			expect(covMap).toMatchSnapshot("cov-map");
		});

		it("should preserve short-circuit evaluation and operand values at runtime", () => {
			expect.assertions(4);

			const fileKey = "and-or-short-circuit.luau";
			const { instrumentedSource } = instrumentFixture(fileKey, fileKey);

			// The fixture prints (1) the evaluation log, (2) the `and` result,
			// (3) the `or` result. The driver appends the branch counters.
			const driver = [
				"",
				`local __b = _G.__jest_roblox_cov["${fileKey}"].b`,
				'print(__b[1][1] .. "," .. __b[1][2] .. "," .. __b[2][1] .. "," .. __b[2][2])',
				"",
			].join("\n");

			const lines = runLuau(instrumentedSource + driver)
				.trim()
				.split(/\r?\n/u);

			// Only the lhs of each operator ran — the rhs short-circuited, so
			// `note("R1", …)` / `note("R2", …)` never executed.
			expect(lines[0]).toBe("L1,L2");
			// `false and …` yields false; `true or …` yields true.
			expect(lines[1]).toBe("false");
			expect(lines[2]).toBe("true");
			// Each branch: arm 1 (lhs) ran once, arm 2 (rhs) short-circuited.
			expect(lines[3]).toBe("1,0,1,0");
		});

		it("should increment the rhs arm and keep its value when the rhs runs", () => {
			expect.assertions(4);

			const fileKey = "and-or-rhs-eval.luau";
			const { instrumentedSource } = instrumentFixture(fileKey, fileKey);

			const driver = [
				"",
				`local __b = _G.__jest_roblox_cov["${fileKey}"].b`,
				'print(__b[1][1] .. "," .. __b[1][2] .. "," .. __b[2][1] .. "," .. __b[2][2])',
				"",
			].join("\n");

			const lines = runLuau(instrumentedSource + driver)
				.trim()
				.split(/\r?\n/u);

			// `true and …` and `false or …` both evaluate the rhs, so every
			// `note(...)` ran in order.
			expect(lines[0]).toBe("L1,R1,L2,R2");
			// The expression yields the rhs value in both cases.
			expect(lines[1]).toBe("42");
			expect(lines[2]).toBe("99");
			// Both arms of each branch ran exactly once.
			expect(lines[3]).toBe("1,1,1,1");
		});
	});

	describe("when producing valid Luau output", () => {
		it("should produce output that Lute can parse without errors", () => {
			expect.assertions(1);

			const { instrumentedSource } = instrumentFixture("simple.luau", "simple.luau");

			expect(validateLuauSource(instrumentedSource)).toBe("OK");
		});
	});
});
