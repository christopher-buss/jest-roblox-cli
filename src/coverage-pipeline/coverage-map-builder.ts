import type { CollectorResult } from "./coverage-collector.ts";
import type { CoverageMap } from "./coverage-map.ts";

export function buildCoverageMap(result: CollectorResult): CoverageMap {
	return {
		branchMap: buildBranchMap(result),
		functionMap: buildFunctionMap(result),
		statementMap: buildStatementMap(result),
	};
}

function buildStatementMap(result: CollectorResult): CoverageMap["statementMap"] {
	const statementMap: CoverageMap["statementMap"] = {};
	for (const statement of result.statements) {
		statementMap[String(statement.index)] = {
			end: { column: statement.location.endColumn, line: statement.location.endLine },
			start: { column: statement.location.beginColumn, line: statement.location.beginLine },
		};
	}

	return statementMap;
}

function buildFunctionMap(result: CollectorResult): NonNullable<CoverageMap["functionMap"]> {
	const functionMap: NonNullable<CoverageMap["functionMap"]> = {};
	for (const func of result.functions) {
		functionMap[String(func.index)] = {
			name: func.name,
			location: {
				end: { column: func.location.endColumn, line: func.location.endLine },
				start: { column: func.location.beginColumn, line: func.location.beginLine },
			},
		};
	}

	return functionMap;
}

function buildBranchMap(result: CollectorResult): NonNullable<CoverageMap["branchMap"]> {
	const branchMap: NonNullable<CoverageMap["branchMap"]> = {};
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

	return branchMap;
}
