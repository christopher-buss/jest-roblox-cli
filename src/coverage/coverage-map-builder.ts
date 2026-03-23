import type { CollectorResult } from "./coverage-collector.ts";
import type { CoverageMap, SourceLocation } from "./types.ts";

export function buildCoverageMap(result: CollectorResult): CoverageMap {
	const statementMap: Record<string, SourceLocation> = {};
	for (const statement of result.statements) {
		statementMap[String(statement.index)] = {
			end: { column: statement.location.endcolumn, line: statement.location.endline },
			start: { column: statement.location.begincolumn, line: statement.location.beginline },
		};
	}

	const functionMap: Record<string, { location: SourceLocation; name: string }> = {};
	for (const func of result.functions) {
		functionMap[String(func.index)] = {
			name: func.name,
			location: {
				end: { column: func.location.endcolumn, line: func.location.endline },
				start: { column: func.location.begincolumn, line: func.location.beginline },
			},
		};
	}

	const branchMap: Record<string, { locations: Array<SourceLocation>; type: string }> = {};
	for (const branch of result.branches) {
		branchMap[String(branch.index)] = {
			locations: branch.arms.map((arm) => {
				return {
					end: { column: arm.location.endcolumn, line: arm.location.endline },
					start: { column: arm.location.begincolumn, line: arm.location.beginline },
				};
			}),
			type: branch.branchType,
		};
	}

	return { branchMap, functionMap, statementMap };
}
