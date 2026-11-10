import type { RawCoverageData } from "../coverage-data/coverage-types.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	TestRecord,
} from "../coverage-data/manifest.ts";
import type { PerTestCoverageEntry } from "../protocol/coverage.ts";
import type { TestSourceResolver } from "./test-source.ts";

/** Per-test attribution harvested from one run. */
export interface AttributionResult {
	/** Per Luau file: statement id → ids of the tests that covered it. */
	coveringTestIds: Record<string, Record<string, Array<string>>>;
	/** Per Luau file: statement ids hit but credited to no test (ADR-0003). */
	staticStatementIds: Record<string, Array<string>>;
	/** Tests that covered at least one statement. */
	tests: Array<TestRecord>;
}

/**
 * Assemble per-test attribution records from the runner's per-test deltas.
 * @param options - Whole-run hits, per-test deltas and test source resolver.
 * @returns Test records, per-statement covering ids and the static set.
 */
export function harvestAttribution({
	cumulative,
	entries,
	resolveTestSource,
}: {
	cumulative: RawCoverageData;
	entries: ReadonlyArray<PerTestCoverageEntry>;
	resolveTestSource: TestSourceResolver;
}): AttributionResult {
	const tests: Array<TestRecord> = [];
	const coveringTestIds: AttributionResult["coveringTestIds"] = {};

	for (const entry of entries) {
		const hasCoveredAnything = Object.values(entry.delta).some(
			(fileDelta) => fileDelta.s.length > 0,
		);
		if (!hasCoveredAnything) {
			continue;
		}

		const testId = `${entry.testFilePath}::${entry.testCaseId}`;

		tests.push({
			...resolveTestSource(entry.testFilePath, entry.testCaseId),
			testCaseId: entry.testCaseId,
			testFilePath: entry.testFilePath,
			testId,
		});

		for (const [fileKey, fileDelta] of Object.entries(entry.delta)) {
			const fileAttribution = (coveringTestIds[fileKey] ??= {});
			for (const statementId of fileDelta.s) {
				(fileAttribution[String(statementId)] ??= []).push(testId);
			}
		}
	}

	return {
		coveringTestIds,
		staticStatementIds: deriveStatic(cumulative, coveringTestIds),
		tests,
	};
}

/**
 * Write one harvest's attribution into a coverage manifest.
 * @param manifest - Manifest to write into.
 * @param attribution - Harvested attribution for this run.
 * @returns Copy of the manifest with this run's attribution only.
 */
export function applyAttribution(
	manifest: CoverageManifest,
	attribution: AttributionResult,
): CoverageManifest {
	const files: CoverageManifest["files"] = {};
	for (const [fileKey, record] of Object.entries(manifest.files)) {
		files[fileKey] = clearAttribution(record);
	}

	for (const [fileKey, coveringTestIds] of Object.entries(attribution.coveringTestIds)) {
		const record = files[fileKey];
		if (record !== undefined) {
			files[fileKey] = { ...record, coveringTestIds };
		}
	}

	for (const [fileKey, staticStatementIds] of Object.entries(attribution.staticStatementIds)) {
		const record = files[fileKey];
		if (record !== undefined) {
			files[fileKey] = { ...record, staticStatementIds };
		}
	}

	return { ...manifest, files, tests: attribution.tests };
}

/**
 * Merge two projects' attribution results.
 * @param a - First attribution result.
 * @param b - Second attribution result.
 * @returns Combined attribution.
 */
export function mergeAttribution(a: AttributionResult, b: AttributionResult): AttributionResult {
	const coveringTestIds: AttributionResult["coveringTestIds"] = {};
	for (const source of [a.coveringTestIds, b.coveringTestIds]) {
		for (const [fileKey, statementMap] of Object.entries(source)) {
			const fileAttribution = (coveringTestIds[fileKey] ??= {});
			for (const [statementId, testIds] of Object.entries(statementMap)) {
				(fileAttribution[statementId] ??= []).push(...testIds);
			}
		}
	}

	const staticStatementIds = mergeStatic({
		a: a.staticStatementIds,
		b: b.staticStatementIds,
		coveringTestIds,
	});

	return { coveringTestIds, staticStatementIds, tests: [...a.tests, ...b.tests] };
}

function deriveStatic(
	cumulative: RawCoverageData,
	coveringTestIds: AttributionResult["coveringTestIds"],
): AttributionResult["staticStatementIds"] {
	const staticStatementIds: AttributionResult["staticStatementIds"] = {};
	for (const [fileKey, fileCoverage] of Object.entries(cumulative)) {
		const credited = coveringTestIds[fileKey];
		const ids = Object.entries(fileCoverage.s)
			.filter(
				([statementId, hitCount]) => hitCount > 0 && credited?.[statementId] === undefined,
			)
			.map(([statementId]) => statementId);
		if (ids.length > 0) {
			staticStatementIds[fileKey] = ids;
		}
	}

	return staticStatementIds;
}

function clearAttribution(record: InstrumentedFileRecord): InstrumentedFileRecord {
	const cleared = { ...record };
	delete cleared.coveringTestIds;
	delete cleared.staticStatementIds;
	return cleared;
}

function mergeStatic({
	a,
	b,
	coveringTestIds,
}: {
	a: AttributionResult["staticStatementIds"];
	b: AttributionResult["staticStatementIds"];
	coveringTestIds: AttributionResult["coveringTestIds"];
}): AttributionResult["staticStatementIds"] {
	const merged: AttributionResult["staticStatementIds"] = {};
	const fileKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const fileKey of fileKeys) {
		const credited = coveringTestIds[fileKey];
		const ids = [...new Set([...(a[fileKey] ?? []), ...(b[fileKey] ?? [])])]
			.filter((statementId) => credited?.[statementId] === undefined)
			.sort((first, second) => Number(first) - Number(second));
		if (ids.length > 0) {
			merged[fileKey] = ids;
		}
	}

	return merged;
}
