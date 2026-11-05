import { describe, expect, it } from "vitest";

import { createLocationsIndexMap, type FileInfo, mapErrorsToTests } from "./error-mapping.ts";
import type { RawErrorsMap, TestDefinition } from "./typecheck-types.ts";

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

function mapSourceFileError(ignoreSourceErrors: boolean): ReturnType<typeof mapErrorsToTests> {
	const errors: RawErrorsMap = new Map([
		[
			"src/source.ts",
			[
				{
					code: "TS2322",
					column: 7,
					filePath: "src/source.ts",
					line: 1,
					message: "Type 'string' is not assignable to type 'number'.",
				},
			],
		],
	]);
	const files = new Map<string, FileInfo>([
		[
			"src/test.test-d.ts",
			{
				definitions: [
					{ name: "should pass", ancestorNames: [], end: 27, start: 0, type: "test" },
				],
				locations: createLocationsIndexMap('it("should pass", () => {});'),
			},
		],
	]);

	return mapErrorsToTests({ errors, files, ignoreSourceErrors, startTime: 123 });
}

describe(mapErrorsToTests, () => {
	it("should mark all tests as passed when no errors exist", () => {
		expect.assertions(2);

		const errors: RawErrorsMap = new Map();
		const files = new Map<string, FileInfo>([
			[
				"/test.ts",
				{
					definitions: [
						{ name: "should pass", ancestorNames: [], end: 27, start: 0, type: "test" },
					],
					locations: createLocationsIndexMap('it("should pass", () => {});'),
				},
			],
		]);

		const result = mapErrorsToTests({ errors, files, startTime: Date.now() });

		expect(result.success).toBeTrue();
		expect(result.testResults[0]!.testResults[0]!.status).toBe("passed");
	});

	it("should fail the test containing the error", () => {
		expect.assertions(4);

		const source =
			'describe("suite", () => {\n  it("should fail", () => {\n    bad;\n  });\n});';
		const errors: RawErrorsMap = new Map([
			[
				"/test.ts",
				[
					{
						code: "TS2322",
						column: 5,
						filePath: "/test.ts",
						line: 3,
						message: "Type mismatch",
					},
				],
			],
		]);

		const definitions: Array<TestDefinition> = [
			{ name: "suite", ancestorNames: [], end: source.length - 1, start: 0, type: "suite" },
			{ name: "should fail", ancestorNames: ["suite"], end: 64, start: 26, type: "test" },
		];
		const files = new Map<string, FileInfo>([
			["/test.ts", { definitions, locations: createLocationsIndexMap(source) }],
		]);

		const result = mapErrorsToTests({ errors, files, startTime: 123 });

		expect(result.success).toBeFalse();
		expect(result.testResults[0]!.testResults[0]!.status).toBe("failed");
		expect(result.testResults[0]!.testResults[0]!.failureMessages).toHaveLength(1);
		expect(result).toMatchSnapshot();
	});

	it("should attribute error outside test blocks to file-level failure", () => {
		expect.assertions(3);

		const source = 'const x: number = "bad";\nit("should pass", () => {});';
		const errors: RawErrorsMap = new Map([
			[
				"/test.ts",
				[
					{
						code: "TS2322",
						column: 7,
						filePath: "/test.ts",
						line: 1,
						message: "Type mismatch",
					},
				],
			],
		]);

		const definitions: Array<TestDefinition> = [
			{ name: "should pass", ancestorNames: [], end: 52, start: 25, type: "test" },
		];
		const files = new Map<string, FileInfo>([
			["/test.ts", { definitions, locations: createLocationsIndexMap(source) }],
		]);

		const result = mapErrorsToTests({ errors, files, startTime: 123 });

		expect(result.success).toBeFalse();
		expect(result.numFailedTests).toBePositive();
		expect(result).toMatchSnapshot();
	});

	it("should attribute an error after a finished test to the file, not that test", () => {
		expect.assertions(1);

		const source = 'it("should pass", () => {});\nconst x: number = "bad";';
		const errors: RawErrorsMap = new Map([
			[
				"/test.ts",
				[
					{
						code: "TS2322",
						column: 7,
						filePath: "/test.ts",
						line: 2,
						message: "Type mismatch",
					},
				],
			],
		]);
		const definitions: Array<TestDefinition> = [
			{ name: "should pass", ancestorNames: [], end: 27, start: 0, type: "test" },
		];
		const files = new Map<string, FileInfo>([
			["/test.ts", { definitions, locations: createLocationsIndexMap(source) }],
		]);

		const result = mapErrorsToTests({ errors, files, startTime: 123 });

		const test = result.testResults[0]!.testResults.find((tc) => tc.title === "should pass");

		expect(test!.status).toBe("passed");
	});

	it("should collect multiple errors in the same test", () => {
		expect.assertions(1);

		const source = 'it("should fail", () => {\n  a;\n  b;\n});';
		const errors: RawErrorsMap = new Map([
			[
				"/test.ts",
				[
					{
						code: "TS2322",
						column: 3,
						filePath: "/test.ts",
						line: 2,
						message: "Error one",
					},
					{
						code: "TS2322",
						column: 3,
						filePath: "/test.ts",
						line: 3,
						message: "Error two",
					},
				],
			],
		]);

		const definitions: Array<TestDefinition> = [
			{ name: "should fail", ancestorNames: [], end: 39, start: 0, type: "test" },
		];
		const files = new Map<string, FileInfo>([
			["/test.ts", { definitions, locations: createLocationsIndexMap(source) }],
		]);

		const result = mapErrorsToTests({ errors, files, startTime: Date.now() });

		expect(result.testResults[0]!.testResults[0]!.failureMessages).toHaveLength(2);
	});

	it("should handle mixed files with and without errors", () => {
		expect.assertions(4);

		const errors: RawErrorsMap = new Map([
			[
				"/fail.ts",
				[
					{
						code: "TS2322",
						column: 1,
						filePath: "/fail.ts",
						line: 1,
						message: "Error",
					},
				],
			],
		]);

		const files = new Map<string, FileInfo>([
			[
				"/fail.ts",
				{
					definitions: [
						{ name: "should fail", ancestorNames: [], end: 27, start: 0, type: "test" },
					],
					locations: createLocationsIndexMap('it("should fail", () => {});'),
				},
			],
			[
				"/pass.ts",
				{
					definitions: [
						{ name: "should pass", ancestorNames: [], end: 27, start: 0, type: "test" },
					],
					locations: createLocationsIndexMap('it("should pass", () => {});'),
				},
			],
		]);

		const result = mapErrorsToTests({ errors, files, startTime: 123 });

		// The result crosses the Jest reporter boundary. Pin its complete shape
		// alongside the aggregate counts below.
		expect(result).toMatchSnapshot();

		expect(result.numFailedTests).toBe(1);
		expect(result.numPassedTests).toBe(1);
		expect(result.numTotalTests).toBe(2);
	});

	it("should surface errors for non-test source files as source-level failures", () => {
		expect.assertions(5);

		const result = mapSourceFileError(false);

		const sourceResult = result.testResults.find(
			(file) => file.testFilePath === "src/source.ts",
		);

		expect(result.success).toBeFalse();
		expect(result.numFailedTests).toBe(1);
		expect(sourceResult).toBeDefined();
		expect(sourceResult!.testResults[0]!.failureMessages[0]).toContain("TS2322");
		expect(result).toMatchSnapshot();
	});

	it("should suppress non-test source file errors when ignoreSourceErrors is true", () => {
		expect.assertions(4);

		const result = mapSourceFileError(true);

		expect(result.success).toBeTrue();
		expect(result.numFailedTests).toBe(0);
		expect(
			result.testResults.find((file) => file.testFilePath === "src/source.ts"),
		).toBeUndefined();
		expect(result).toMatchSnapshot();
	});

	it("should produce correct JestResult counts", () => {
		expect.assertions(4);

		const errors: RawErrorsMap = new Map();
		const files = new Map<string, FileInfo>([
			[
				"/test.ts",
				{
					definitions: [
						{ name: "should a", ancestorNames: [], end: 23, start: 0, type: "test" },
						{ name: "should b", ancestorNames: [], end: 48, start: 25, type: "test" },
					],
					locations: createLocationsIndexMap(
						'it("should a", () => {});\nit("should b", () => {});',
					),
				},
			],
		]);

		const result = mapErrorsToTests({ errors, files, startTime: Date.now() });

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
						code: "TS2322",
						column: 1,
						filePath: "/test.ts",
						line: 999,
						message: "Out of bounds",
					},
				],
			],
		]);

		const files = new Map<string, FileInfo>([
			[
				"/test.ts",
				{
					definitions: [
						{ name: "should pass", ancestorNames: [], end: 27, start: 0, type: "test" },
					],
					locations: createLocationsIndexMap(source),
				},
			],
		]);

		const result = mapErrorsToTests({ errors, files, startTime: Date.now() });

		expect(result.numFailedTests).toBe(1);
	});

	it("should attribute an end-boundary diagnostic to the innermost overlapping test", () => {
		expect.assertions(1);

		const source = 'it("outer", () => { it("inner", () => { bad; }); });';
		const badIndex = source.indexOf("bad");
		const innerStart = source.indexOf('it("inner"');
		const errors: RawErrorsMap = new Map([
			[
				"src/nested.spec.ts",
				[
					{
						code: "TS2322",
						column: badIndex + 1,
						filePath: "src/nested.spec.ts",
						line: 1,
						message: "Nested mismatch",
					},
				],
			],
		]);
		const files = new Map<string, FileInfo>([
			[
				"src/nested.spec.ts",
				{
					definitions: [
						{
							name: "outer",
							ancestorNames: [],
							end: source.length,
							start: 0,
							type: "test",
						},
						{
							name: "inner",
							ancestorNames: ["outer"],
							end: badIndex,
							start: innerStart,
							type: "test",
						},
					],
					locations: createLocationsIndexMap(source),
				},
			],
		]);

		const result = mapErrorsToTests({ errors, files, startTime: 123 });

		expect(result.testResults[0]!.testResults).toStrictEqual([
			{
				ancestorTitles: [],
				failureMessages: [],
				fullName: "outer",
				status: "passed",
				title: "outer",
			},
			{
				ancestorTitles: ["outer"],
				failureMessages: ["TS2322: Nested mismatch"],
				fullName: "outer > inner",
				status: "failed",
				title: "inner",
			},
		]);
	});
});
