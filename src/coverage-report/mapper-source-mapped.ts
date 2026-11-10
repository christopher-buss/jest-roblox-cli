import assert from "node:assert";

import type { SourceLocation } from "../coverage-data/coverage-map.ts";
import type { RawCoverageData } from "../coverage-data/coverage-types.ts";
import { resolveSourcePath } from "../coverage-data/source-path.ts";
import { fileStatementsFor, pendingListFor, pushPendingBranch } from "./mapper-pending.ts";
import type {
	PendingCoverage,
	PendingStatement,
	PositionResolver,
	SourceMapped,
} from "./mapper-types.ts";

interface MappedPosition {
	column: number;
	line: number;
	source: string;
}

interface MappedSpan {
	end: MappedPosition;
	start: MappedPosition;
}

interface AddOrCoalesceOptions {
	hitCount: number;
	pending: PendingCoverage["statements"];
	span: MappedSpan;
}

interface MappedArmLocations {
	locations: Array<{
		end: { column: number; line: number };
		start: { column: number; line: number };
	}>;
	tsPath: string;
}

/**
 * Map one Luau file through its source map into pending coverage.
 * @param options - Hit counts, pending coverage and source-map resources.
 */
export function mapSourceMappedFile({
	fileCoverage,
	pending,
	resources,
}: {
	/** Hit counts for the Luau file. */
	fileCoverage: RawCoverageData[string];
	/** Receives the mapped entries. */
	pending: PendingCoverage;
	/** The file's coverage map, source map directory and position resolver. */
	resources: SourceMapped;
}): void {
	const file = { fileCoverage, resources };
	const resolvedTsPaths = mapFileStatements({ ...file, pending: pending.statements });
	mapFileFunctions({ ...file, pendingFunctions: pending.functions, resolvedTsPaths });
	mapFileBranches({ ...file, pendingBranches: pending.branches });
}

function mapStatement({
	resolvePosition,
	sourceMapDirectory,
	span,
}: {
	resolvePosition: PositionResolver;
	sourceMapDirectory: string;
	span: { end: { column: number; line: number }; start: { column: number; line: number } };
}): MappedSpan | undefined {
	const mappedStart = resolvePosition({
		column: Math.max(0, span.start.column - 1),
		line: span.start.line,
	});

	const mappedEnd = resolvePosition({
		column: Math.max(0, span.end.column - 1),
		line: span.end.line,
	});

	if (mappedStart.source === null || mappedStart.source !== mappedEnd.source) {
		return undefined;
	}

	const resolvedSource = resolveSourcePath(mappedStart.source, sourceMapDirectory);
	return {
		end: {
			column: mappedEnd.column,
			line: mappedEnd.line,
			source: resolvedSource,
		},
		start: {
			column: mappedStart.column,
			line: mappedStart.line,
			source: resolvedSource,
		},
	};
}

function maxPosition(
	a: { column: number; line: number },
	b: { column: number; line: number },
): { column: number; line: number } {
	if (a.line > b.line) {
		return a;
	}

	if (b.line > a.line) {
		return b;
	}

	return { column: Math.max(a.column, b.column), line: a.line };
}

function findCoalescenceTarget(
	sameLine: ReadonlyArray<PendingStatement>,
	{ end, start }: MappedSpan,
): PendingStatement | undefined {
	const exact = sameLine.find((candidate) => candidate.start.column === start.column);
	if (exact !== undefined) {
		return exact;
	}

	if (end.line > start.line) {
		return sameLine[0];
	}

	return sameLine.find((candidate) => candidate.end.line > candidate.start.line);
}

function addOrCoalesce({ hitCount, pending, span }: AddOrCoalesceOptions): void {
	const { end, start } = span;
	const fileStatements = fileStatementsFor(pending, start.source);
	const sameLine = pendingListFor(fileStatements, start.line);
	const existing = findCoalescenceTarget(sameLine, span);

	if (existing === undefined) {
		sameLine.push({
			end: { column: end.column, line: end.line },
			hitCount,
			start: { column: start.column, line: start.line },
		});
		return;
	}

	existing.hitCount += hitCount;
	existing.end = maxPosition(existing.end, { column: end.column, line: end.line });
	existing.start.column = Math.min(existing.start.column, start.column);
}

function mapFileStatements({
	fileCoverage,
	pending,
	resources,
}: {
	fileCoverage: RawCoverageData[string];
	pending: PendingCoverage["statements"];
	resources: SourceMapped;
}): Set<string> {
	const resolvedTsPaths = new Set<string>();

	for (const [statementId, span] of Object.entries(resources.coverageMap.statementMap)) {
		const hitCount = fileCoverage.s[statementId] ?? 0;

		const mapped = mapStatement({
			resolvePosition: resources.resolvePosition,
			sourceMapDirectory: resources.sourceMapDirectory,
			span,
		});
		if (mapped === undefined) {
			continue;
		}

		resolvedTsPaths.add(mapped.start.source);
		addOrCoalesce({ hitCount, pending, span: mapped });
	}

	return resolvedTsPaths;
}

function addUnmappedFunction({
	name,
	hitCount,
	pendingFunctions,
	resolvedTsPaths,
}: {
	hitCount: number;
	name: string;
	pendingFunctions: PendingCoverage["functions"];
	resolvedTsPaths: Set<string>;
}): void {
	const fallbackPath = resolvedTsPaths.values().next().value;
	if (fallbackPath === undefined) {
		return;
	}

	pendingListFor(pendingFunctions, fallbackPath).push({
		name,
		hitCount,
		loc: {
			end: { column: 0, line: 1 },
			start: { column: 0, line: 1 },
		},
	});
}

function mapFileFunctions({
	fileCoverage,
	pendingFunctions,
	resolvedTsPaths,
	resources,
}: {
	fileCoverage: RawCoverageData[string];
	pendingFunctions: PendingCoverage["functions"];
	resolvedTsPaths: Set<string>;
	resources: SourceMapped;
}): void {
	if (resources.coverageMap.functionMap === undefined) {
		return;
	}

	for (const [functionId, entry] of Object.entries(resources.coverageMap.functionMap)) {
		const hitCount = fileCoverage.f?.[functionId] ?? 0;

		const mapped = mapStatement({
			resolvePosition: resources.resolvePosition,
			sourceMapDirectory: resources.sourceMapDirectory,
			span: entry.location,
		});

		if (mapped === undefined) {
			addUnmappedFunction({ name: entry.name, hitCount, pendingFunctions, resolvedTsPaths });
			continue;
		}

		pendingListFor(pendingFunctions, mapped.start.source).push({
			name: entry.name,
			hitCount,
			loc: {
				end: { column: mapped.end.column, line: mapped.end.line },
				start: { column: mapped.start.column, line: mapped.start.line },
			},
		});
	}
}

function mapBranchArmLocations({
	locations,
	resolvePosition,
	sourceMapDirectory,
}: {
	locations: ReadonlyArray<SourceLocation>;
	resolvePosition: PositionResolver;
	sourceMapDirectory: string;
}): MappedArmLocations | undefined {
	const mappedLocations: MappedArmLocations["locations"] = [];
	let tsPath: string | undefined;

	for (const location of locations) {
		const mapped = mapStatement({ resolvePosition, sourceMapDirectory, span: location });
		if (mapped === undefined) {
			return undefined;
		}

		if (tsPath === undefined) {
			tsPath = mapped.start.source;
		} else if (tsPath !== mapped.start.source) {
			return undefined;
		}

		mappedLocations.push({
			end: { column: mapped.end.column, line: mapped.end.line },
			start: { column: mapped.start.column, line: mapped.start.line },
		});
	}

	if (tsPath === undefined) {
		return undefined;
	}

	return { locations: mappedLocations, tsPath };
}

function isSamePosition(
	a: { column: number; line: number },
	b: { column: number; line: number },
): boolean {
	return a.line === b.line && a.column === b.column;
}

function hasCollapsedPhantomArm(locations: MappedArmLocations["locations"]): boolean {
	const [first] = locations;
	assert(first !== undefined);
	return locations.every((arm) => {
		return isSamePosition(arm.start, first.start) && isSamePosition(arm.end, first.start);
	});
}

function mapFileBranches({
	fileCoverage,
	pendingBranches,
	resources,
}: {
	fileCoverage: RawCoverageData[string];
	pendingBranches: PendingCoverage["branches"];
	resources: SourceMapped;
}): void {
	if (resources.coverageMap.branchMap === undefined) {
		return;
	}

	for (const [branchId, entry] of Object.entries(resources.coverageMap.branchMap)) {
		const armHitCounts = fileCoverage.b?.[branchId] ?? [];

		const result = mapBranchArmLocations({
			locations: entry.locations,
			resolvePosition: resources.resolvePosition,
			sourceMapDirectory: resources.sourceMapDirectory,
		});
		if (result === undefined) {
			continue;
		}

		// Gated to statement `if`: a real single-line `expr-if` collapses the
		// same way.
		if (entry.type === "if" && hasCollapsedPhantomArm(result.locations)) {
			continue;
		}

		pushPendingBranch({
			armHitCounts,
			entry,
			fileBranches: pendingListFor(pendingBranches, result.tsPath),
			locations: result.locations,
		});
	}
}
