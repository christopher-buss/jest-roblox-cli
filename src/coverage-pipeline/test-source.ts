import assert from "node:assert";

import type { SourceMapper } from "../source-mapper/index.ts";
import type { JestResult, TestFileResult } from "../types/jest-result.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { hashString } from "../utils/hash.ts";
import type { TestRecord } from "./manifest.ts";
import { resolveTestFileHash } from "./test-file-hash.ts";

export type TestSourceResolver = (testFilePath: string, testCaseId: string) => TestSource;

/** What the harvester records about one test's source, keyed off its file. */
type TestSource = Pick<TestRecord, "location" | "testFileSourceHash" | "testSourceHash">;

type TestSourceMapper = Pick<SourceMapper, "mapTestFileLine" | "resolveTestFilePath">;

interface FileSources {
	byTestCaseId: Map<string, TestSource>;
	fileOnly: TestSource;
}

/**
 * Build the seam `harvestAttribution` reads a test's source through, from the
 * Jest result the run produced. The per-test entries name a test file by the
 * DataModel path the hook read off the Instance; Jest names the same file by
 * whatever `CoreScriptSyncService` answered, which is the DataModel path under
 * this CLI's Open Cloud stub and the source file's disk path under Studio. The
 * two meet on the disk path the source mapper resolves each to, and the test
 * on its full name.
 *
 * A test with a reported location gets that location in the coordinates of
 * the file `testFileSourceHash` hashes, and a hash of its own range of that
 * file. A test without one (the runtime could not read its call site) is
 * keyed on the whole file, as before.
 */
export function createTestSourceResolver(
	result: JestResult,
	sourceMapper: TestSourceMapper | undefined,
	fileSystem: FileSystem = nodeFileSystem,
): TestSourceResolver {
	const filesByPath = new Map<string, FileSources>();

	return (testFilePath, testCaseId) => {
		let file = filesByPath.get(testFilePath);
		if (file === undefined) {
			file = collectFileSources(fileSystem, result, testFilePath, sourceMapper);
			filesByPath.set(testFilePath, file);
		}

		return file.byTestCaseId.get(testCaseId) ?? file.fileOnly;
	};
}

/**
 * Hash the text of each test's range: from its start line up to the next
 * distinct start line, and to end of file for the last one. Tests that start
 * on the same line (the rows of an `each` table) share a range. This is how
 * Stryker's incremental mode closes a location a runner reports as a start
 * position only.
 *
 * @param sourceText - The test file's text.
 * @param startLines - One-based start lines, in any order, duplicates allowed.
 * @returns Each distinct start line's hash of its range.
 */
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

function findFileResult(
	result: JestResult,
	testFilePath: string,
	diskPath: string | undefined,
	sourceMapper: TestSourceMapper | undefined,
): TestFileResult | undefined {
	return result.testResults.find((fileResult) => {
		if (fileResult.testFilePath === testFilePath) {
			return true;
		}

		const fileDiskPath =
			sourceMapper?.resolveTestFilePath(fileResult.testFilePath) ?? fileResult.testFilePath;
		return diskPath !== undefined && fileDiskPath === diskPath;
	});
}

/**
 * Each located test's line in the resolved file, by full name. A name that
 * occurs twice (the rows of an `each` table) keeps its first line.
 */
function locateTests(
	fileResult: TestFileResult,
	testFilePath: string,
	sourceMapper: TestSourceMapper,
): Map<string, number> {
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

function collectFileSources(
	fileSystem: FileSystem,
	result: JestResult,
	testFilePath: string,
	sourceMapper: TestSourceMapper | undefined,
): FileSources {
	const testFileSourceHash = resolveTestFileHash(sourceMapper, testFilePath, fileSystem) ?? "";
	const fileOnly: TestSource = { testFileSourceHash };
	const byTestCaseId = new Map<string, TestSource>();

	const diskPath = sourceMapper?.resolveTestFilePath(testFilePath);
	const fileResult = findFileResult(result, testFilePath, diskPath, sourceMapper);
	if (
		sourceMapper === undefined ||
		fileResult === undefined ||
		diskPath === undefined ||
		!fileSystem.existsSync(diskPath)
	) {
		return { byTestCaseId, fileOnly };
	}

	const linesByTestCaseId = locateTests(fileResult, testFilePath, sourceMapper);
	const rangeHashes = hashTestRanges(
		fileSystem.readFileSync(diskPath, "utf-8"),
		linesByTestCaseId.values(),
	);
	for (const [testCaseId, line] of linesByTestCaseId) {
		const testSourceHash = rangeHashes.get(line);
		assert(testSourceHash !== undefined, `no range hashed for line ${String(line)}`);
		byTestCaseId.set(testCaseId, {
			location: { column: 0, line },
			testFileSourceHash,
			testSourceHash,
		});
	}

	return { byTestCaseId, fileOnly };
}
