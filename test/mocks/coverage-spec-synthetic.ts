import type { CoverageManifest, RawCoverageData } from "#src/api.ts";

export function buildSyntheticCoverage(files: CoverageManifest["files"]): RawCoverageData {
	const data: RawCoverageData = {};

	for (const [fileKey, record] of Object.entries(files)) {
		const statementHits: Record<string, number> = {};
		for (let index = 0; index < record.statementCount; index++) {
			statementHits[String(index)] = 1;
		}

		const functionHits: Record<string, number> = {};
		for (let index = 0; index < (record.functionCount ?? 0); index++) {
			functionHits[String(index)] = 1;
		}

		const branchHits: Record<string, Array<number>> = {};
		for (let index = 0; index < (record.branchCount ?? 0); index++) {
			branchHits[String(index)] = [1, 1];
		}

		data[fileKey] = { b: branchHits, f: functionHits, s: statementHits };
	}

	return data;
}
