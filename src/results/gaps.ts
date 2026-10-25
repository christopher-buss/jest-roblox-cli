import type { GapRecord, GapTally } from "../backends/interface.ts";
import type { JestResult, TestCaseResult, TestFileResult } from "../types/jest-result.ts";

/** A test or file whose result is no evidence, because a gap reached it. */
export interface BlockedEntry {
	file: TestFileResult;
	gaps: GapTally;
	test?: TestCaseResult;
}

interface TestGaps {
	name: string;
	gaps: GapTally;
}

interface FileGaps {
	gaps: GapTally;
	tests: Map<number, TestGaps>;
}

const RAN: ReadonlySet<TestCaseResult["status"]> = new Set(["failed", "passed"]);

/**
 * A run whose gap record does not cover its results, so no test of it can be
 * called clean.
 */
export class MissingGapRecordError extends Error {}

/**
 * Every Blocked test with the gaps that block it, its own and its file's, and
 * every file with gaps but no test.
 *
 * @param result - A result that carries gaps.
 */
export function listBlocked(result: JestResult): Array<BlockedEntry> {
	return result.testResults.flatMap((file) => {
		const fileGaps = file.gaps ?? {};
		if (file.testResults.length === 0) {
			return hasGaps(fileGaps) ? [{ file, gaps: fileGaps }] : [];
		}

		return file.testResults
			.map((test) => {
				return { file, gaps: addGaps({ ...fileGaps }, test.gaps ?? {}), test };
			})
			.filter((entry) => hasGaps(entry.gaps));
	});
}

/**
 * Put each gap of `record` on the test and file result that raised it, and
 * fail the run when any test is Blocked. Jest status values stay as they are.
 *
 * @param result - The Jest result, with test files still named by DataModel
 *   path.
 * @param record - The run's gap record.
 */
export function applyGapRecord(result: JestResult, record: GapRecord): void {
	const byFile = groupByFile(record);
	for (const file of result.testResults) {
		const reported = byFile.get(file.testFilePath);
		byFile.delete(file.testFilePath);
		file.gaps = addGaps({ ...record.unattributed }, reported?.gaps ?? {});
		applyTestGaps(file, reported?.tests ?? new Map());
	}

	const [lostFile] = byFile.keys();
	if (lostFile !== undefined) {
		throw new MissingGapRecordError(`The run reported ${lostFile}, but has no result for it`);
	}

	failWhenBlocked(result);
}

/**
 * Put every gap of a run that produced no Jest result on each file it reports.
 *
 * @param result - The synthetic result of the failed run.
 * @param record - The run's gap record.
 */
export function applyFailureGaps(result: JestResult, record: GapRecord): void {
	const gaps = { ...record.unattributed };
	for (const entry of record.attributed) {
		addGaps(gaps, entry.gaps);
	}

	for (const file of result.testResults) {
		file.gaps = { ...gaps };
	}
}

function addGaps(into: GapTally, from: GapTally): GapTally {
	for (const [member, count] of Object.entries(from)) {
		into[member] = (into[member] ?? 0) + count;
	}

	return into;
}

function hasGaps(gaps: GapTally): boolean {
	return Object.keys(gaps).length > 0;
}

function groupByFile(record: GapRecord): Map<string, FileGaps> {
	const byFile = new Map<string, FileGaps>();
	for (const entry of record.attributed) {
		let file = byFile.get(entry.file);
		if (file === undefined) {
			file = { gaps: {}, tests: new Map() };
			byFile.set(entry.file, file);
		}

		if (entry.test === undefined) {
			addGaps(file.gaps, entry.gaps);
		} else {
			const gaps = file.tests.get(entry.position)?.gaps ?? {};
			file.tests.set(entry.position, { name: entry.test, gaps: addGaps(gaps, entry.gaps) });
		}
	}

	return byFile;
}

function applyTestGaps(file: TestFileResult, reported: Map<number, TestGaps>): void {
	for (const [index, test] of file.testResults.entries()) {
		const position = index + 1;
		const entry = reported.get(position);
		reported.delete(position);
		if (entry !== undefined && entry.name !== test.fullName) {
			throw new MissingGapRecordError(
				`The run reported "${entry.name}" as test ${String(position)} of ${file.testFilePath}, but the result there is "${test.fullName}"`,
			);
		}

		if (entry === undefined && RAN.has(test.status)) {
			throw new MissingGapRecordError(
				`The run has no gap record for "${test.fullName}" in ${file.testFilePath}`,
			);
		}

		test.gaps = entry?.gaps ?? {};
	}

	const [lost] = reported.values();
	if (lost !== undefined) {
		throw new MissingGapRecordError(
			`The run reported "${lost.name}" in ${file.testFilePath}, but has no result for it`,
		);
	}
}

function failWhenBlocked(result: JestResult): void {
	if (listBlocked(result).length > 0) {
		result.success = false;
	}
}
