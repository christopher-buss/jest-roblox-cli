import type { CoverageManifest, InstrumentedFileRecord, TestRecord } from "./manifest.ts";
import type { PerTestCoverageEntry, RawCoverageData } from "./types.ts";

export interface AttributionResult {
	/** Per Luau file: statement id → ids of the tests that covered it. */
	coveringTestIds: Record<string, Record<string, Array<string>>>;
	/**
	 * Per Luau file: statement ids hit during the run but credited to no
	 * per-test window (module-load or hook code). The static-mutant set of
	 * ADR-0003.
	 */
	staticStatementIds: Record<string, Array<string>>;
	tests: Array<TestRecord>;
}

/**
 * Assemble the per-test attribution records the coverage manifest carries from
 * the runner's per-test deltas. `cumulative` is the whole-run hit table, used
 * to derive the static set (statements hit but credited to no test window).
 * `resolveSourceHash` maps a test file path to its source hash (an injected
 * seam so the harvester stays pure and fs-free).
 */
export function harvestAttribution(
	entries: ReadonlyArray<PerTestCoverageEntry>,
	cumulative: RawCoverageData,
	resolveSourceHash: (testFilePath: string) => string | undefined,
): AttributionResult {
	const tests: Array<TestRecord> = [];
	const coveringTestIds: AttributionResult["coveringTestIds"] = {};

	for (const entry of entries) {
		// A test that covered nothing new (e.g. a pure assertion against already-
		// exercised state) carries no attribution, so it is not recorded.
		const hasCoveredAnything = Object.values(entry.delta).some(
			(fileDelta) => fileDelta.s.length > 0,
		);
		if (!hasCoveredAnything) {
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

	return {
		coveringTestIds,
		staticStatementIds: deriveStatic(cumulative, coveringTestIds),
		tests,
	};
}

/**
 * Write an attribution result into a coverage manifest: set `tests[]` and
 * place each file's per-statement `coveringTestIds` and `staticStatementIds`
 * on its record. Attribution for a file absent from the manifest (e.g. a
 * covered helper outside the report universe) is dropped — the manifest's file
 * set stays the source of truth.
 *
 * Every record drops both attribution fields before either is written, so what
 * a record carries always comes from one harvest. A warm shadow carries an
 * unchanged file's record forward verbatim and the two fields are written from
 * separate maps, so a file this run has static ids for but no covering ids for
 * would otherwise keep the last run's covering ids — and consumers read the two
 * sets as one run's disjoint halves.
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
 * Merge two attribution results: concatenate the test records, union the
 * per-statement covering ids, and union the static sets. A statement static in
 * one project but credited to a test in the other is not static across the
 * merged run, so the union drops any id credited in the merged
 * `coveringTestIds`. Used to combine per-project attribution from a
 * multi-project run.
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

	const staticStatementIds = mergeStatic(
		a.staticStatementIds,
		b.staticStatementIds,
		coveringTestIds,
	);

	return { coveringTestIds, staticStatementIds, tests: [...a.tests, ...b.tests] };
}

/**
 * A statement is static iff it was hit in the run (`count > 0`) but never
 * credited to a per-test window — i.e. its id is not a key in `coveringTestIds`
 * for that file. Ids are sorted numerically so the manifest stays stable.
 */
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
			.map(([statementId]) => statementId)
			.sort((a, b) => Number(a) - Number(b));
		if (ids.length > 0) {
			staticStatementIds[fileKey] = ids;
		}
	}

	return staticStatementIds;
}

/**
 * A record with neither attribution field, ready to take this run's. Both go
 * together: leaving one behind is what pairs two runs' halves on one record.
 */
function clearAttribution(record: InstrumentedFileRecord): InstrumentedFileRecord {
	const cleared = { ...record };
	delete cleared.coveringTestIds;
	delete cleared.staticStatementIds;
	return cleared;
}

function mergeStatic(
	a: AttributionResult["staticStatementIds"],
	b: AttributionResult["staticStatementIds"],
	coveringTestIds: AttributionResult["coveringTestIds"],
): AttributionResult["staticStatementIds"] {
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
