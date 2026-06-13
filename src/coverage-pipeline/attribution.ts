import type { CoverageManifest, TestRecord } from "./manifest.ts";
import type { PerTestCoverageEntry } from "./types.ts";

export interface AttributionResult {
	/** Per Luau file: statement id → ids of the tests that covered it. */
	coveringTestIds: Record<string, Record<string, Array<string>>>;
	tests: Array<TestRecord>;
}

/**
 * Assemble the per-test attribution records the coverage manifest carries from
 * the runner's per-test deltas. `resolveSourceHash` maps a test file path to its
 * source hash (an injected seam so the harvester stays pure and fs-free).
 */
export function harvestAttribution(
	entries: ReadonlyArray<PerTestCoverageEntry>,
	resolveSourceHash: (testFilePath: string) => string | undefined,
): AttributionResult {
	const tests: Array<TestRecord> = [];
	const coveringTestIds: Record<string, Record<string, Array<string>>> = {};

	for (const entry of entries) {
		// A test that covered nothing new (e.g. a pure assertion against already-
		// exercised state) carries no attribution, so it is not recorded.
		const coveredAnything = Object.values(entry.delta).some(
			(fileDelta) => fileDelta.s.length > 0,
		);
		if (!coveredAnything) {
			continue;
		}

		const testId = `${entry.testFilePath}::${entry.testCaseId}`;

		tests.push({
			testCaseId: entry.testCaseId,
			testFilePath: entry.testFilePath,
			testFileSourceHash: resolveSourceHash(entry.testFilePath) ?? "",
			testId,
		});

		for (const [fileKey, fileDelta] of Object.entries(entry.delta)) {
			const fileAttribution = (coveringTestIds[fileKey] ??= {});
			for (const statementId of fileDelta.s) {
				(fileAttribution[String(statementId)] ??= []).push(testId);
			}
		}
	}

	return { coveringTestIds, tests };
}

/**
 * Write an attribution result into a coverage manifest: set `tests[]` and place
 * each file's per-statement `coveringTestIds` on its record. Attribution for a
 * file absent from the manifest (e.g. a covered helper outside the report
 * universe) is dropped — the manifest's file set stays the source of truth.
 */
export function applyAttribution(
	manifest: CoverageManifest,
	attribution: AttributionResult,
): CoverageManifest {
	const files = { ...manifest.files };
	for (const [fileKey, coveringTestIds] of Object.entries(attribution.coveringTestIds)) {
		const record = files[fileKey];
		if (record !== undefined) {
			files[fileKey] = { ...record, coveringTestIds };
		}
	}

	return { ...manifest, files, tests: attribution.tests };
}

/**
 * Merge two attribution results: concatenate the test records and union the
 * per-statement covering ids. Used to combine per-project attribution from a
 * multi-project run into the single manifest.
 */
export function mergeAttribution(a: AttributionResult, b: AttributionResult): AttributionResult {
	const coveringTestIds: Record<string, Record<string, Array<string>>> = {};
	for (const source of [a.coveringTestIds, b.coveringTestIds]) {
		for (const [fileKey, statementMap] of Object.entries(source)) {
			const fileAttribution = (coveringTestIds[fileKey] ??= {});
			for (const [statementId, testIds] of Object.entries(statementMap)) {
				(fileAttribution[statementId] ??= []).push(...testIds);
			}
		}
	}

	return { coveringTestIds, tests: [...a.tests, ...b.tests] };
}
