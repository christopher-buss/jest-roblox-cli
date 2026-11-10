import istanbulCoverage from "istanbul-lib-coverage";
import * as path from "node:path";

import type { MappedCoverageResult, MappedFileCoverage } from "./mapper-types.ts";

type FileCoverageData = istanbulCoverage.FileCoverageData;

/**
 * Restate mapped coverage as an Istanbul coverage map.
 * @param mapped - Coverage mapped onto source files.
 * @returns Istanbul map keyed by absolute file path.
 */
export function buildCoverageMap(mapped: MappedCoverageResult): istanbulCoverage.CoverageMap {
	const coverageMap = istanbulCoverage.createCoverageMap({});

	for (const [filePath, fileCoverage] of Object.entries(mapped.files)) {
		const fileCoverageData = {
			b: fileCoverage.b,
			branchMap: toIstanbulBranchMap(fileCoverage.branchMap),
			f: fileCoverage.f,
			fnMap: toIstanbulFuncMap(fileCoverage.fnMap),
			path: path.resolve(filePath),
			s: fileCoverage.s,
			statementMap: fileCoverage.statementMap,
		} satisfies FileCoverageData;
		coverageMap.addFileCoverage(fileCoverageData);
	}

	return coverageMap;
}

function toIstanbulBranchMap(
	branchMap: MappedFileCoverage["branchMap"],
): FileCoverageData["branchMap"] {
	return Object.fromEntries(
		Object.entries(branchMap).map(([id, entry]) => {
			return [
				id,
				{
					line: entry.loc.start.line,
					loc: entry.loc,
					locations: entry.locations,
					type: entry.type,
				},
			];
		}),
	);
}

function toIstanbulFuncMap(funcMap: MappedFileCoverage["fnMap"]): FileCoverageData["fnMap"] {
	return Object.fromEntries(
		Object.entries(funcMap).map(([id, entry]) => {
			return [
				id,
				{
					name: entry.name,
					decl: entry.loc,
					line: entry.loc.start.line,
					loc: entry.loc,
				},
			];
		}),
	);
}
