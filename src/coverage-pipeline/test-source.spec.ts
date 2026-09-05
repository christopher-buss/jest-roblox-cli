import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { JestResult, TestCaseResult } from "../types/jest-result.ts";
import { hashFile, hashString } from "../utils/hash.ts";
import { createTestSourceResolver } from "./test-source.ts";

const SOURCE = ["import x;", "", "it('a', () => {", "});", "", "it('b', () => {", "});", ""].join(
	"\n",
);

function testCase(fullName: string, line?: number): TestCaseResult {
	return {
		ancestorTitles: [],
		failureMessages: [],
		fullName,
		status: "passed",
		title: fullName,
		...(line === undefined ? {} : { location: { column: 0, line } }),
	};
}

function jestResult(testFilePath: string, cases: Array<TestCaseResult>): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: cases.length,
		numPendingTests: 0,
		numTotalTests: cases.length,
		startTime: 0,
		success: true,
		testResults: [
			{
				numFailingTests: 0,
				numPassingTests: cases.length,
				numPendingTests: 0,
				testFilePath,
				testResults: cases,
			},
		],
	};
}

/**
 * A mapper that resolves every test file to `diskPath` and offsets lines by
 * `lineShift`.
 */
function mapperFor(diskPath: string | undefined, lineShift = 0) {
	return {
		mapTestFileLine: (_testFilePath: string, luauLine: number) => luauLine + lineShift,
		resolveTestFilePath: () => diskPath,
	};
}

describe(createTestSourceResolver, () => {
	it("should close each test's range at the next test's start and the last at end of file", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/src", { recursive: true });

		volume.writeFileSync("/src/m.spec.ts", SOURCE);

		const resolve = createTestSourceResolver(
			jestResult("ReplicatedStorage/m.spec", [testCase("b", 6), testCase("a", 3)]),
			mapperFor("/src/m.spec.ts"),
			fileSystem,
		);

		expect(resolve("ReplicatedStorage/m.spec", "a").testSourceHash).toBe(
			hashString("it('a', () => {\n});\n"),
		);
		expect(resolve("ReplicatedStorage/m.spec", "b").testSourceHash).toBe(
			hashString("it('b', () => {\n});\n"),
		);
	});

	it("should hash from the first line when a test starts there", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/src", { recursive: true });

		volume.writeFileSync("/src/m.spec.ts", "a\nb");

		const resolve = createTestSourceResolver(
			jestResult("ReplicatedStorage/m.spec", [testCase("a", 1)]),
			mapperFor("/src/m.spec.ts"),
			fileSystem,
		);

		expect(resolve("ReplicatedStorage/m.spec", "a").testSourceHash).toBe(hashString("a\nb"));
	});

	it("should record the mapped line and the range hash of a located test", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/src", { recursive: true });

		volume.writeFileSync("/src/m.spec.ts", SOURCE);

		// Luau lines 10 and 13 map to TypeScript lines 3 and 6.
		const resolve = createTestSourceResolver(
			jestResult("ReplicatedStorage/m.spec", [testCase("a", 10), testCase("b", 13)]),
			mapperFor("/src/m.spec.ts", -7),
			fileSystem,
		);

		expect(resolve("ReplicatedStorage/m.spec", "a")).toStrictEqual({
			location: { column: 0, line: 3 },
			testFileSourceHash: hashFile("/src/m.spec.ts", fileSystem),
			testSourceHash: hashString("it('a', () => {\n});\n"),
		});
	});

	it("should join a Jest file named by its disk path, as Studio reports it", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/src", { recursive: true });

		volume.writeFileSync("/src/m.spec.ts", SOURCE);

		// Only the DataModel form resolves; the disk form is already on disk.
		const diskPaths = new Map([["ReplicatedStorage/m.spec", "/src/m.spec.ts"]]);
		const mapper = {
			mapTestFileLine: (_testFilePath: string, luauLine: number) => luauLine,
			resolveTestFilePath: (testFilePath: string) => diskPaths.get(testFilePath),
		};
		const resolve = createTestSourceResolver(
			jestResult("/src/m.spec.ts", [testCase("a", 3)]),
			mapper,
			fileSystem,
		);

		expect(resolve("ReplicatedStorage/m.spec", "a").location).toStrictEqual({
			column: 0,
			line: 3,
		});
	});

	it("should give each-table rows on one line the same range hash", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/src", { recursive: true });

		volume.writeFileSync("/src/m.spec.ts", SOURCE);

		const resolve = createTestSourceResolver(
			jestResult("ReplicatedStorage/m.spec", [
				testCase("row true", 3),
				testCase("row false", 3),
				testCase("b", 6),
			]),
			mapperFor("/src/m.spec.ts"),
			fileSystem,
		);

		expect(resolve("ReplicatedStorage/m.spec", "row false").testSourceHash).toBe(
			resolve("ReplicatedStorage/m.spec", "row true").testSourceHash,
		);
	});

	it("should fall back to the file hash alone when the line has no source mapping", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/src", { recursive: true });

		volume.writeFileSync("/src/m.spec.ts", SOURCE);

		const resolve = createTestSourceResolver(
			jestResult("ReplicatedStorage/m.spec", [testCase("a", 3)]),
			{ mapTestFileLine: () => {}, resolveTestFilePath: () => "/src/m.spec.ts" },
			fileSystem,
		);

		expect(resolve("ReplicatedStorage/m.spec", "a")).toStrictEqual({
			testFileSourceHash: hashFile("/src/m.spec.ts", fileSystem),
		});
	});

	it("should fall back to the file hash alone for a test without a location", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/src", { recursive: true });

		volume.writeFileSync("/src/m.spec.ts", SOURCE);

		const resolve = createTestSourceResolver(
			jestResult("ReplicatedStorage/m.spec", [testCase("a")]),
			mapperFor("/src/m.spec.ts"),
			fileSystem,
		);

		expect(resolve("ReplicatedStorage/m.spec", "a")).toStrictEqual({
			testFileSourceHash: hashFile("/src/m.spec.ts", fileSystem),
		});
	});

	it("should record an empty file hash when the test file is not on disk", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const resolve = createTestSourceResolver(
			jestResult("ReplicatedStorage/m.spec", [testCase("a", 3)]),
			mapperFor("/src/missing.spec.ts"),
			fileSystem,
		);

		expect(resolve("ReplicatedStorage/m.spec", "a")).toStrictEqual({ testFileSourceHash: "" });
	});

	it("should record an empty file hash when there is no source mapper", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const resolve = createTestSourceResolver(
			jestResult("ReplicatedStorage/m.spec", [testCase("a", 3)]),
			undefined,
			fileSystem,
		);

		expect(resolve("ReplicatedStorage/m.spec", "a")).toStrictEqual({ testFileSourceHash: "" });
	});
});
