import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import {
	createLocationsIndexMap,
	isCompositeProject,
	mapErrorsToTests,
	runTypecheck,
} from "./runner.ts";
import type { RawErrorsMap, TestDefinition } from "./types.ts";

vi.mock(import("node:child_process"));
vi.mock(import("node:fs"));

describe(createLocationsIndexMap, () => {
	it("should map line:column pairs to character indices", () => {
		expect.assertions(3);

		const source = "abc\ndef\n";
		const indexMap = createLocationsIndexMap(source);

		expect(indexMap.get("1:1")).toBe(0);
		expect(indexMap.get("1:3")).toBe(2);
		expect(indexMap.get("2:1")).toBe(4);
	});
});

describe(mapErrorsToTests, () => {
	it("should mark all tests as passed when no errors exist", () => {
		expect.assertions(2);

		const errors: RawErrorsMap = new Map();
		const files = new Map<string, { definitions: Array<TestDefinition>; source: string }>([
			[
				"/test.ts",
				{
					definitions: [
						{ name: "should pass", ancestorNames: [], end: 27, start: 0, type: "test" },
					],
					source: 'it("should pass", () => {});',
				},
			],
		]);

		const result = mapErrorsToTests(errors, files, Date.now());

		expect(result.success).toBeTrue();
		expect(result.testResults[0]!.testResults[0]!.status).toBe("passed");
	});

	it("should fail the test containing the error", () => {
		expect.assertions(3);

		const source =
			'describe("suite", () => {\n  it("should fail", () => {\n    bad;\n  });\n});';
		const errors: RawErrorsMap = new Map([
			[
				"/test.ts",
				[
					{
						column: 5,
						errorCode: 2322,
						errorMessage: "Type mismatch",
						filePath: "/test.ts",
						line: 3,
					},
				],
			],
		]);

		const definitions: Array<TestDefinition> = [
			{ name: "suite", ancestorNames: [], end: source.length - 1, start: 0, type: "suite" },
			{ name: "should fail", ancestorNames: ["suite"], end: 64, start: 26, type: "test" },
		];
		const files = new Map<string, { definitions: Array<TestDefinition>; source: string }>([
			["/test.ts", { definitions, source }],
		]);

		const result = mapErrorsToTests(errors, files, Date.now());

		expect(result.success).toBeFalse();
		expect(result.testResults[0]!.testResults[0]!.status).toBe("failed");
		expect(result.testResults[0]!.testResults[0]!.failureMessages).toHaveLength(1);
	});

	it("should attribute error outside test blocks to file-level failure", () => {
		expect.assertions(2);

		const source = 'const x: number = "bad";\nit("should pass", () => {});';
		const errors: RawErrorsMap = new Map([
			[
				"/test.ts",
				[
					{
						column: 7,
						errorCode: 2322,
						errorMessage: "Type mismatch",
						filePath: "/test.ts",
						line: 1,
					},
				],
			],
		]);

		const definitions: Array<TestDefinition> = [
			{ name: "should pass", ancestorNames: [], end: 52, start: 25, type: "test" },
		];
		const files = new Map<string, { definitions: Array<TestDefinition>; source: string }>([
			["/test.ts", { definitions, source }],
		]);

		const result = mapErrorsToTests(errors, files, Date.now());

		expect(result.success).toBeFalse();
		expect(result.numFailedTests).toBePositive();
	});

	it("should collect multiple errors in the same test", () => {
		expect.assertions(1);

		const source = 'it("should fail", () => {\n  a;\n  b;\n});';
		const errors: RawErrorsMap = new Map([
			[
				"/test.ts",
				[
					{
						column: 3,
						errorCode: 2322,
						errorMessage: "Error one",
						filePath: "/test.ts",
						line: 2,
					},
					{
						column: 3,
						errorCode: 2322,
						errorMessage: "Error two",
						filePath: "/test.ts",
						line: 3,
					},
				],
			],
		]);

		const definitions: Array<TestDefinition> = [
			{ name: "should fail", ancestorNames: [], end: 39, start: 0, type: "test" },
		];
		const files = new Map<string, { definitions: Array<TestDefinition>; source: string }>([
			["/test.ts", { definitions, source }],
		]);

		const result = mapErrorsToTests(errors, files, Date.now());

		expect(result.testResults[0]!.testResults[0]!.failureMessages).toHaveLength(2);
	});

	it("should handle mixed files with and without errors", () => {
		expect.assertions(3);

		const errors: RawErrorsMap = new Map([
			[
				"/fail.ts",
				[
					{
						column: 1,
						errorCode: 2322,
						errorMessage: "Error",
						filePath: "/fail.ts",
						line: 1,
					},
				],
			],
		]);

		const files = new Map<string, { definitions: Array<TestDefinition>; source: string }>([
			[
				"/fail.ts",
				{
					definitions: [
						{ name: "should fail", ancestorNames: [], end: 27, start: 0, type: "test" },
					],
					source: 'it("should fail", () => {});',
				},
			],
			[
				"/pass.ts",
				{
					definitions: [
						{ name: "should pass", ancestorNames: [], end: 27, start: 0, type: "test" },
					],
					source: 'it("should pass", () => {});',
				},
			],
		]);

		const result = mapErrorsToTests(errors, files, Date.now());

		expect(result.numFailedTests).toBe(1);
		expect(result.numPassedTests).toBe(1);
		expect(result.numTotalTests).toBe(2);
	});

	it("should produce correct JestResult counts", () => {
		expect.assertions(4);

		const errors: RawErrorsMap = new Map();
		const files = new Map<string, { definitions: Array<TestDefinition>; source: string }>([
			[
				"/test.ts",
				{
					definitions: [
						{ name: "should a", ancestorNames: [], end: 23, start: 0, type: "test" },
						{ name: "should b", ancestorNames: [], end: 48, start: 25, type: "test" },
					],
					source: 'it("should a", () => {});\nit("should b", () => {});',
				},
			],
		]);

		const result = mapErrorsToTests(errors, files, Date.now());

		expect(result.numTotalTests).toBe(2);
		expect(result.numPassedTests).toBe(2);
		expect(result.numFailedTests).toBe(0);
		expect(result.success).toBeTrue();
	});

	it("should treat error with out-of-bounds position as file-level failure", () => {
		expect.assertions(1);

		const source = 'it("should pass", () => {});';
		const errors: RawErrorsMap = new Map([
			[
				"/test.ts",
				[
					{
						column: 1,
						errorCode: 2322,
						errorMessage: "Out of bounds",
						filePath: "/test.ts",
						line: 999,
					},
				],
			],
		]);

		const files = new Map<string, { definitions: Array<TestDefinition>; source: string }>([
			[
				"/test.ts",
				{
					definitions: [
						{ name: "should pass", ancestorNames: [], end: 27, start: 0, type: "test" },
					],
					source,
				},
			],
		]);

		const result = mapErrorsToTests(errors, files, Date.now());

		expect(result.numFailedTests).toBe(1);
	});
});

describe(isCompositeProject, () => {
	it("should return true when compilerOptions.composite is true", () => {
		expect.assertions(1);

		vi.mocked(fs.readFileSync).mockReturnValue(
			JSON.stringify({ compilerOptions: { composite: true } }),
		);

		expect(isCompositeProject("/project")).toBeTrue();
	});

	it("should return false when composite is absent", () => {
		expect.assertions(1);

		vi.mocked(fs.readFileSync).mockReturnValue(
			JSON.stringify({ compilerOptions: { strict: true } }),
		);

		expect(isCompositeProject("/project")).toBeFalse();
	});

	it("should return false when tsconfig does not exist", () => {
		expect.assertions(1);

		vi.mocked(fs.readFileSync).mockImplementation(() => {
			throw new Error("ENOENT");
		});

		expect(isCompositeProject("/project")).toBeFalse();
	});

	it("should return false on malformed JSON", () => {
		expect.assertions(1);

		vi.mocked(fs.readFileSync).mockReturnValue("not json{{{");

		expect(isCompositeProject("/project")).toBeFalse();
	});

	it("should detect composite in tsconfig with comments", () => {
		expect.assertions(1);

		vi.mocked(fs.readFileSync).mockReturnValue(
			'// this is a comment\n{ "compilerOptions": { "composite": true } }',
		);

		expect(isCompositeProject("/project")).toBeTrue();
	});

	it("should detect composite in tsconfig with trailing commas", () => {
		expect.assertions(1);

		vi.mocked(fs.readFileSync).mockReturnValue(
			'{ "compilerOptions": { "composite": true, }, }',
		);

		expect(isCompositeProject("/project")).toBeTrue();
	});

	it("should warn when custom tsconfig cannot be read", () => {
		expect.assertions(2);

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		vi.mocked(fs.readFileSync).mockImplementation(() => {
			throw new Error("ENOENT");
		});

		const result = isCompositeProject("/project", "tsconfig.build.json");

		expect(result).toBeFalse();
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("tsconfig.build.json"));

		stderrSpy.mockRestore();
	});

	it("should warn with stringified error when thrown value is not an Error", () => {
		expect.assertions(2);

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		vi.mocked(fs.readFileSync).mockImplementation(() => {
			// eslint-disable-next-line ts/only-throw-error -- testing non-Error throw
			throw "raw string error";
		});

		const result = isCompositeProject("/project", "tsconfig.build.json");

		expect(result).toBeFalse();
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("raw string error"));

		stderrSpy.mockRestore();
	});

	it("should not warn when default tsconfig does not exist", () => {
		expect.assertions(2);

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		vi.mocked(fs.readFileSync).mockImplementation(() => {
			throw new Error("ENOENT");
		});

		const result = isCompositeProject("/project");

		expect(result).toBeFalse();
		expect(stderrSpy).not.toHaveBeenCalled();

		stderrSpy.mockRestore();
	});

	it("should resolve custom tsconfig path against root directory", () => {
		expect.assertions(1);

		vi.mocked(fs.readFileSync).mockReturnValue(
			JSON.stringify({ compilerOptions: { composite: true } }),
		);

		isCompositeProject("/project", "tsconfig.build.json");

		expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
			path.resolve("/project", "tsconfig.build.json"),
			"utf-8",
		);
	});
});

describe(runTypecheck, () => {
	function mockReadFileSync(tsconfigContent: string, testFileContent: string): void {
		vi.mocked(fs.readFileSync).mockImplementation((filePath, _encoding) => {
			const fileString = String(filePath);
			if (fileString.endsWith("tsconfig.json") || fileString.endsWith("tsconfig.test.json")) {
				return tsconfigContent;
			}

			return testFileContent;
		});
	}

	it("should pass tsconfig option to tsgo for non-composite project", () => {
		expect.assertions(4);

		vi.mocked(childProcess.execFileSync).mockReturnValue("");
		mockReadFileSync(JSON.stringify({ compilerOptions: {} }), 'it("should pass", () => {});');

		const result = runTypecheck({
			files: ["src/test.spec.ts"],
			rootDir: "/project",
			tsconfig: "tsconfig.test.json",
		});

		expect(result.success).toBeTrue();

		const callArgs = vi.mocked(childProcess.execFileSync).mock.calls[0]![1] as Array<string>;

		expect(vi.mocked(childProcess.execFileSync)).toHaveBeenCalledWith(
			process.execPath,
			expect.anything(),
			expect.anything(),
		);
		expect(callArgs).toContain("-p");
		expect(callArgs).toContain(path.resolve("/project", "tsconfig.test.json"));
	});

	it("should use --noEmit for non-composite projects", () => {
		expect.assertions(2);

		vi.mocked(childProcess.execFileSync).mockReturnValue("");
		mockReadFileSync(JSON.stringify({ compilerOptions: {} }), 'it("should pass", () => {});');

		const result = runTypecheck({
			files: ["src/test.spec.ts"],
			rootDir: "/project",
		});

		const callArgs = vi.mocked(childProcess.execFileSync).mock.calls[0]![1] as Array<string>;

		expect(result.success).toBeTrue();
		expect(callArgs).toContain("--noEmit");
	});

	it("should use --build --emitDeclarationOnly for composite projects", () => {
		expect.assertions(3);

		vi.mocked(childProcess.execFileSync).mockReturnValue("");
		mockReadFileSync(
			JSON.stringify({ compilerOptions: { composite: true } }),
			'it("should pass", () => {});',
		);

		const result = runTypecheck({
			files: ["src/test.spec.ts"],
			rootDir: "/project",
		});

		const callArgs = vi.mocked(childProcess.execFileSync).mock.calls[0]![1] as Array<string>;

		expect(result.success).toBeTrue();
		expect(callArgs).toContain("--build");
		expect(callArgs).toContain("--emitDeclarationOnly");
	});

	it("should pass tsconfig as positional arg for composite --build", () => {
		expect.assertions(1);

		vi.mocked(childProcess.execFileSync).mockReturnValue("");
		mockReadFileSync(
			JSON.stringify({ compilerOptions: { composite: true } }),
			'it("should pass", () => {});',
		);

		runTypecheck({
			files: ["src/test.spec.ts"],
			rootDir: "/project",
			tsconfig: "tsconfig.test.json",
		});

		const callArgs = vi.mocked(childProcess.execFileSync).mock.calls[0]![1] as Array<string>;

		expect(callArgs.at(-1)).toBe(path.resolve("/project", "tsconfig.test.json"));
	});

	it("should store testFilePath as relative to rootDir", () => {
		expect.assertions(1);

		vi.mocked(childProcess.execFileSync).mockReturnValue("");
		mockReadFileSync(JSON.stringify({ compilerOptions: {} }), 'it("should pass", () => {});');

		const result = runTypecheck({
			files: ["src/test.spec.ts"],
			rootDir: "/project",
		});

		expect(result.testResults[0]!.testFilePath).toBe(
			normalizeWindowsPath(path.relative("/project", path.resolve("src/test.spec.ts"))),
		);
	});

	it("should rethrow when spawn fails without stdout or stderr", () => {
		expect.assertions(1);

		vi.mocked(childProcess.execFileSync).mockImplementation(() => {
			throw new Error("spawn failed");
		});
		mockReadFileSync(JSON.stringify({ compilerOptions: {} }), 'it("should pass", () => {});');

		expect(() => {
			return runTypecheck({
				files: ["src/test.spec.ts"],
				rootDir: "/project",
			});
		}).toThrowWithMessage(Error, "spawn failed");
	});

	it("should handle tsgo failure by parsing stderr/stdout", () => {
		expect.assertions(1);

		const filePath = "src/test.spec.ts";
		const resolvedFile = path.resolve(filePath);
		const rootDirectory = path.dirname(resolvedFile);
		const relativePath = path.relative(rootDirectory, resolvedFile);

		vi.mocked(childProcess.execFileSync).mockImplementation(() => {
			throw Object.assign(new Error("exit code 2"), {
				stdout: `${relativePath}(1,7): error TS2322: Type 'string' is not assignable to type 'number'.`,
			});
		});
		mockReadFileSync(
			JSON.stringify({ compilerOptions: {} }),
			'const x: number = "bad";\nit("should fail", () => {});',
		);

		const result = runTypecheck({
			files: [filePath],
			rootDir: rootDirectory,
		});

		expect(result.numFailedTests).toBePositive();
	});

	it("should fall back to stderr when stdout is undefined", () => {
		expect.assertions(1);

		const filePath = "src/test.spec.ts";
		const resolvedFile = path.resolve(filePath);
		const rootDirectory = path.dirname(resolvedFile);
		const relativePath = path.relative(rootDirectory, resolvedFile);

		vi.mocked(childProcess.execFileSync).mockImplementation(() => {
			throw Object.assign(new Error("exit code 2"), {
				stderr: `${relativePath}(1,7): error TS2322: Type 'string' is not assignable to type 'number'.`,
				stdout: undefined,
			});
		});
		mockReadFileSync(
			JSON.stringify({ compilerOptions: {} }),
			'const x: number = "bad";\nit("should fail", () => {});',
		);

		const result = runTypecheck({
			files: [filePath],
			rootDir: rootDirectory,
		});

		expect(result.numFailedTests).toBePositive();
	});

	it("should return empty string when both stdout and stderr are undefined", () => {
		expect.assertions(1);

		vi.mocked(childProcess.execFileSync).mockImplementation(() => {
			throw Object.assign(new Error("exit code 2"), {
				stderr: undefined,
				stdout: undefined,
			});
		});
		mockReadFileSync(JSON.stringify({ compilerOptions: {} }), 'it("should pass", () => {});');

		const result = runTypecheck({
			files: ["src/test.spec.ts"],
			rootDir: "/project",
		});

		expect(result.success).toBeTrue();
	});
});
