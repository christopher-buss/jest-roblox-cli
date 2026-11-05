import type { SourceLocation } from "./coverage-map.ts";
import type { RawCoverageData } from "./coverage-types.ts";
import { fileStatementsFor, pendingListFor, pushPendingBranch } from "./mapper-pending.ts";
import type {
	FileResources,
	PendingBranch,
	PendingCoverage,
	PendingStatement,
} from "./mapper-types.ts";

interface PassthroughOptions {
	fileCoverage: RawCoverageData[string];
	pending: PendingCoverage;
	resources: FileResources;
}

/**
 * Accumulate a file's hits into pending coverage at their Luau spans, with
 * columns shifted to Istanbul's 0-based form.
 * @param options - Raw hits, pending coverage and the file's resources.
 */
export function passthroughFile(options: PassthroughOptions): void {
	passthroughFileStatements(options);
	passthroughFileFunctions(options);
	passthroughFileBranches(options);
}

function toIstanbulColumn(luauColumn: number): number {
	return Math.max(0, luauColumn - 1);
}

function passthroughFileStatements({ fileCoverage, pending, resources }: PassthroughOptions): void {
	const fileStatements = fileStatementsFor(pending.statements, resources.sourceKey);

	for (const [statementId, span] of Object.entries(resources.coverageMap.statementMap)) {
		const statement: PendingStatement = {
			end: { column: toIstanbulColumn(span.end.column), line: span.end.line },
			hitCount: fileCoverage.s[statementId] ?? 0,
			start: { column: toIstanbulColumn(span.start.column), line: span.start.line },
		};
		pendingListFor(fileStatements, statement.start.line).push(statement);
	}
}

function passthroughFileFunctions({ fileCoverage, pending, resources }: PassthroughOptions): void {
	if (resources.coverageMap.functionMap === undefined) {
		return;
	}

	const fileFunctions = pendingListFor(pending.functions, resources.sourceKey);

	for (const [functionId, entry] of Object.entries(resources.coverageMap.functionMap)) {
		fileFunctions.push({
			name: entry.name,
			hitCount: fileCoverage.f?.[functionId] ?? 0,
			loc: {
				end: {
					column: toIstanbulColumn(entry.location.end.column),
					line: entry.location.end.line,
				},
				start: {
					column: toIstanbulColumn(entry.location.start.column),
					line: entry.location.start.line,
				},
			},
		});
	}
}

function toIstanbulLocations(locations: ReadonlyArray<SourceLocation>): PendingBranch["locations"] {
	return locations.map((location) => {
		return {
			end: { column: toIstanbulColumn(location.end.column), line: location.end.line },
			start: { column: toIstanbulColumn(location.start.column), line: location.start.line },
		};
	});
}

function passthroughFileBranches({ fileCoverage, pending, resources }: PassthroughOptions): void {
	if (resources.coverageMap.branchMap === undefined) {
		return;
	}

	const fileBranches = pendingListFor(pending.branches, resources.sourceKey);

	for (const [branchId, entry] of Object.entries(resources.coverageMap.branchMap)) {
		const armHitCounts = fileCoverage.b?.[branchId] ?? [];
		const locations = toIstanbulLocations(entry.locations);
		if (locations.length === 0) {
			continue;
		}

		pushPendingBranch({
			armHitCounts,
			entry,
			fileBranches,
			locations,
		});
	}
}
