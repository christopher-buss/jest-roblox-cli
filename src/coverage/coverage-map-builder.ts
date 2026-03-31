import type { CollectorResult } from "./coverage-collector.ts";
import type { CoverageMap, SourceLocation } from "./types.ts";

export function buildCoverageMap(result: CollectorResult): CoverageMap {
	const statementMap: Record<string, SourceLocation> = {};
	for (const statement of result.statements) {
		statementMap[String(statement.index)] = {
			end: { column: statement.location.endColumn, line: statement.location.endLine },
			start: { column: statement.location.beginColumn, line: statement.location.beginLine },
		};
	}

	const functionMap: Record<string, { location: SourceLocation; name: string }> = {};
	for (const func of result.functions) {
		functionMap[String(func.index)] = {
			name: func.name,
			location: {
				end: { column: func.location.endColumn, line: func.location.endLine },
				start: { column: func.location.beginColumn, line: func.location.beginLine },
			},
		};
	}

	const branchMap: Record<string, { locations: Array<SourceLocation>; type: string }> = {};
	for (const branch of result.branches) {
		branchMap[String(branch.index)] = {
			locations: branch.arms.map((arm) => {
				return {
					end: { column: arm.location.endColumn, line: arm.location.endLine },
					start: { column: arm.location.beginColumn, line: arm.location.beginLine },
				};
			}),
			type: branch.branchType,
		};
	}

	return { branchMap, functionMap, statementMap };
}
