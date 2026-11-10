import assert from "node:assert";

import type { TestRecord } from "../coverage-data/manifest.ts";
import type { SourceMapper } from "../source-mapper/index.ts";
import type { JestResult, TestFileResult } from "../types/jest-result-types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { hashFile, hashString } from "../utils/hash.ts";

/** Answers what the harvester records about one test's source. */
export type TestSourceResolver = (testFilePath: string, testCaseId: string) => TestSource;

type TestSource = Pick<TestRecord, "location" | "testFileSourceHash" | "testSourceHash">;

type TestSourceMapper = Pick<SourceMapper, "mapTestFileLine" | "resolveTestFilePath">;

interface FileSources {
	byTestCaseId: Map<string, TestSource>;
	fileOnly: TestSource;
}

/**
 * Build the test source resolver from the run's Jest result.
 * @param options - File system, Jest result and source mapper.
 * @returns Resolver that caches its work per test file.
 */
export function createTestSourceResolver({
	fileSystem,
	result,
	sourceMapper,
}: {
	fileSystem: FileSystem;
	result: JestResult;
	sourceMapper: TestSourceMapper | undefined;
}): TestSourceResolver {
	const filesByPath = new Map<string, FileSources>();

	return (testFilePath, testCaseId) => {
		let file = filesByPath.get(testFilePath);
		if (file === undefined) {
			file = collectFileSources({ fileSystem, result, sourceMapper, testFilePath });
			filesByPath.set(testFilePath, file);
		}

		return file.byTestCaseId.get(testCaseId) ?? file.fileOnly;
	};
}

function hashTestRanges(sourceText: string, startLines: Iterable<number>): Map<number, string> {
	const lines = sourceText.split("\n");
	const starts = [...new Set(startLines)].sort((a, b) => a - b);

	const rangeHashes = new Map<number, string>();
	for (const [index, start] of starts.entries()) {
		const end = starts[index + 1] ?? lines.length + 1;
		rangeHashes.set(start, hashString(lines.slice(start - 1, end - 1).join("\n")));
	}

	return rangeHashes;
}

function findFileResult({
	diskPath,
	result,
	sourceMapper,
}: {
	diskPath: string;
	result: JestResult;
	sourceMapper: TestSourceMapper;
}): TestFileResult | undefined {
	return result.testResults.find((fileResult) => {
		const fileDiskPath =
			sourceMapper.resolveTestFilePath(fileResult.testFilePath) ?? fileResult.testFilePath;
		return fileDiskPath === diskPath;
	});
}

function locateTests({
	fileResult,
	sourceMapper,
	testFilePath,
}: {
	fileResult: TestFileResult;
	sourceMapper: TestSourceMapper;
	testFilePath: string;
}): Map<string, number> {
	const linesByTestCaseId = new Map<string, number>();
	for (const testCase of fileResult.testResults) {
		if (testCase.location === undefined || linesByTestCaseId.has(testCase.fullName)) {
			continue;
		}

		const line = sourceMapper.mapTestFileLine(testFilePath, testCase.location.line);
		if (line !== undefined) {
			linesByTestCaseId.set(testCase.fullName, line);
		}
	}

	return linesByTestCaseId;
}

function collectFileSources({
	fileSystem,
	result,
	sourceMapper,
	testFilePath,
}: {
	fileSystem: FileSystem;
	result: JestResult;
	sourceMapper: TestSourceMapper | undefined;
	testFilePath: string;
}): FileSources {
	const byTestCaseId = new Map<string, TestSource>();
	const diskPath = sourceMapper?.resolveTestFilePath(testFilePath);
	if (sourceMapper === undefined || diskPath === undefined || !fileSystem.existsSync(diskPath)) {
		return { byTestCaseId, fileOnly: { testFileSourceHash: "" } };
	}

	const testFileSourceHash = hashFile(diskPath, fileSystem);
	const fileOnly: TestSource = { testFileSourceHash };

	const fileResult = findFileResult({ diskPath, result, sourceMapper });
	if (fileResult === undefined) {
		return { byTestCaseId, fileOnly };
	}

	const linesByTestCaseId = locateTests({ fileResult, sourceMapper, testFilePath });
	const rangeHashes = hashTestRanges(
		fileSystem.readFileSync(diskPath, "utf-8"),
		linesByTestCaseId.values(),
	);
	for (const [testCaseId, line] of linesByTestCaseId) {
		const testSourceHash = rangeHashes.get(line);
		assert(testSourceHash !== undefined);
		byTestCaseId.set(testCaseId, {
			location: { column: 0, line },
			testFileSourceHash,
			testSourceHash,
		});
	}

	return { byTestCaseId, fileOnly };
}
