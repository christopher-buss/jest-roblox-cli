import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";

import { type } from "arktype";
import assert from "node:assert";
import * as fs from "node:fs";

import type { CoverageManifest, RawCoverageData } from "./types.ts";

const positionSchema = type({ column: "number", line: "number" });
const spanSchema = type({ end: positionSchema, start: positionSchema });
const functionEntrySchema = type({
	name: "string",
	location: type({ end: positionSchema, start: positionSchema }),
});
const branchEntrySchema = type({
	locations: type("Record<string, unknown>[]"),
	type: "string",
});
const NESTED_RECORD = "Record<string, Record<string, unknown>>" as const;
const coverageMapSchema = type({
	"branchMap?": NESTED_RECORD,
	"functionMap?": NESTED_RECORD,
	"statementMap": type(NESTED_RECORD),
});

export interface MappedFileCoverage {
	b: Record<string, Array<number>>;
	branchMap: Record<
		string,
		{
			loc: {
				end: { column: number; line: number };
				start: { column: number; line: number };
			};
			locations: Array<{
				end: { column: number; line: number };
				start: { column: number; line: number };
			}>;
			type: string;
		}
	>;
	f: Record<string, number>;
	fnMap: Record<
		string,
		{
			loc: { end: { column: number; line: number }; start: { column: number; line: number } };
			name: string;
		}
	>;
	path: string;
	s: Record<string, number>;
	statementMap: Record<
		string,
		{ end: { column: number; line: number }; start: { column: number; line: number } }
	>;
}

export interface MappedCoverageResult {
	files: Record<string, MappedFileCoverage>;
}

interface PendingStatement {
	end: { column: number; line: number };
	hitCount: number;
	start: { column: number; line: number };
}

interface PendingFunction {
	name: string;
	hitCount: number;
	loc: { end: { column: number; line: number }; start: { column: number; line: number } };
}

interface PendingBranch {
	armHitCounts: Array<number>;
	loc: {
		end: { column: number; line: number };
		start: { column: number; line: number };
	};
	locations: Array<{
		end: { column: number; line: number };
		start: { column: number; line: number };
	}>;
	type: string;
}

interface MappedPosition {
	column: number;
	line: number;
	source: string;
}

interface FileResources {
	coverageMap: typeof coverageMapSchema.infer;
	sourceKey: string;
	traceMap: TraceMap | undefined;
}

interface MappedArmLocations {
	locations: Array<{
		end: { column: number; line: number };
		start: { column: number; line: number };
	}>;
	tsPath: string;
}

interface SourceMapped {
	coverageMap: FileResources["coverageMap"];
	traceMap: TraceMap;
}

export function mapCoverageToTypeScript(
	coverageData: RawCoverageData,
	manifest: CoverageManifest,
): MappedCoverageResult {
	const pendingStatements = new Map<string, Map<string, PendingStatement>>();
	const pendingFunctions = new Map<string, Array<PendingFunction>>();
	const pendingBranches = new Map<string, Array<PendingBranch>>();

	for (const [fileKey, fileCoverage] of Object.entries(coverageData)) {
		const record = manifest.files[fileKey];
		if (record === undefined) {
			continue;
		}

		const resources = loadFileResources(record);
		if (resources === undefined) {
			continue;
		}

		if (resources.traceMap === undefined) {
			passthroughFileStatements(resources, fileCoverage, pendingStatements);
			passthroughFileFunctions(resources, fileCoverage, pendingFunctions);
			passthroughFileBranches(resources, fileCoverage, pendingBranches);
		} else {
			const mapped = { coverageMap: resources.coverageMap, traceMap: resources.traceMap };
			const resolvedTsPaths = mapFileStatements(mapped, fileCoverage, pendingStatements);
			mapFileFunctions(mapped, fileCoverage, pendingFunctions, resolvedTsPaths);
			mapFileBranches(mapped, fileCoverage, pendingBranches);
		}
	}

	return buildResult(pendingStatements, pendingFunctions, pendingBranches);
}

// --- Luau column → Istanbul column conversion ---
// Luau columns are 1-based; Istanbul expects 0-based.

function loadFileResources(record: CoverageManifest["files"][string]): FileResources | undefined {
	let coverageMapRaw: string;
	try {
		coverageMapRaw = fs.readFileSync(record.coverageMapPath, "utf-8");
	} catch {
		return undefined;
	}

	const parsed = coverageMapSchema(JSON.parse(coverageMapRaw));
	if (parsed instanceof type.errors) {
		return undefined;
	}

	let traceMap: TraceMap | undefined;
	try {
		const sourceMapRaw = fs.readFileSync(record.sourceMapPath, "utf-8");
		traceMap = new TraceMap(sourceMapRaw);
	} catch {
		// No source map — native Luau file, passthrough mode
	}

	return { coverageMap: parsed, sourceKey: record.key, traceMap };
}

// --- Passthrough helpers for native Luau (no source map) ---

function toIstanbulColumn(luauColumn: number): number {
	return Math.max(0, luauColumn - 1);
}

function passthroughFileStatements(
	resources: FileResources,
	fileCoverage: RawCoverageData[string],
	pending: Map<string, Map<string, PendingStatement>>,
): void {
	let fileStatements = pending.get(resources.sourceKey);
	if (fileStatements === undefined) {
		fileStatements = new Map();
		pending.set(resources.sourceKey, fileStatements);
	}

	for (const [statementId, rawSpan] of Object.entries(resources.coverageMap.statementMap)) {
		const span = spanSchema(rawSpan);
		if (span instanceof type.errors) {
			continue;
		}

		const hitCount = fileCoverage.s[statementId] ?? 0;
		fileStatements.set(statementId, {
			end: { column: toIstanbulColumn(span.end.column), line: span.end.line },
			hitCount,
			start: { column: toIstanbulColumn(span.start.column), line: span.start.line },
		});
	}
}

function passthroughFileFunctions(
	resources: FileResources,
	fileCoverage: RawCoverageData[string],
	pendingFunctions: Map<string, Array<PendingFunction>>,
): void {
	if (resources.coverageMap.functionMap === undefined) {
		return;
	}

	let fileFunctions = pendingFunctions.get(resources.sourceKey);
	if (fileFunctions === undefined) {
		fileFunctions = [];
		pendingFunctions.set(resources.sourceKey, fileFunctions);
	}

	for (const [functionId, rawEntry] of Object.entries(resources.coverageMap.functionMap)) {
		const entry = functionEntrySchema(rawEntry);
		if (entry instanceof type.errors) {
			continue;
		}

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

// --- Source-mapped helpers (roblox-ts → TypeScript) ---

function passthroughFileBranches(
	resources: FileResources,
	fileCoverage: RawCoverageData[string],
	pendingBranches: Map<string, Array<PendingBranch>>,
): void {
	if (resources.coverageMap.branchMap === undefined) {
		return;
	}

	let fileBranches = pendingBranches.get(resources.sourceKey);
	if (fileBranches === undefined) {
		fileBranches = [];
		pendingBranches.set(resources.sourceKey, fileBranches);
	}

	for (const [branchId, rawEntry] of Object.entries(resources.coverageMap.branchMap)) {
		const entry = branchEntrySchema(rawEntry);
		if (entry instanceof type.errors) {
			continue;
		}

		const armHitCounts = fileCoverage.b?.[branchId] ?? [];
		const locations: PendingBranch["locations"] = [];

		for (const rawLocation of entry.locations) {
			const location = spanSchema(rawLocation);
			if (location instanceof type.errors) {
				continue;
			}

			locations.push({
				end: { column: toIstanbulColumn(location.end.column), line: location.end.line },
				start: {
					column: toIstanbulColumn(location.start.column),
					line: location.start.line,
				},
			});
		}

		if (locations.length === 0) {
			continue;
		}

		const firstLocation = locations[0];
		const lastLocation = locations[locations.length - 1];
		assert(
			firstLocation !== undefined && lastLocation !== undefined,
			"Branch locations must not be empty after filtering",
		);

		fileBranches.push({
			armHitCounts: entry.locations.map((_, index) => armHitCounts[index] ?? 0),
			loc: {
				end: lastLocation.end,
				start: firstLocation.start,
			},
			locations,
			type: entry.type,
		});
	}
}

function mapStatement(
	traceMap: TraceMap,
	span: { end: { column: number; line: number }; start: { column: number; line: number } },
): undefined | { end: MappedPosition; start: MappedPosition } {
	// Luau columns are 1-based, source maps expect 0-based
	const mappedStart = originalPositionFor(traceMap, {
		column: Math.max(0, span.start.column - 1),
		line: span.start.line,
	});

	const mappedEnd = originalPositionFor(traceMap, {
		column: Math.max(0, span.end.column - 1),
		line: span.end.line,
	});

	if (
		mappedStart.source === null ||
		mappedEnd.source === null ||
		mappedStart.source !== mappedEnd.source
	) {
		return undefined;
	}

	// trace-mapping guarantees column/line are non-null
	// when source is non-null
	return {
		end: {
			column: mappedEnd.column,
			line: mappedEnd.line,
			source: mappedEnd.source,
		},
		start: {
			column: mappedStart.column,
			line: mappedStart.line,
			source: mappedStart.source,
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

	return a.column >= b.column ? a : b;
}

function addOrCoalesce(
	pending: Map<string, Map<string, PendingStatement>>,
	start: MappedPosition,
	end: MappedPosition,
	hitCount: number,
): void {
	const tsPath = start.source;

	let fileStatements = pending.get(tsPath);
	if (fileStatements === undefined) {
		fileStatements = new Map();
		pending.set(tsPath, fileStatements);
	}

	// Key is per-file (partitioned by tsPath), so identical
	// start positions in different files cannot collide
	const coalescenceKey = `${String(start.line)}:${String(start.column)}`;
	const existing = fileStatements.get(coalescenceKey);

	if (existing !== undefined) {
		existing.hitCount += hitCount;
		existing.end = maxPosition(existing.end, { column: end.column, line: end.line });
	} else {
		fileStatements.set(coalescenceKey, {
			end: { column: end.column, line: end.line },
			hitCount,
			start: { column: start.column, line: start.line },
		});
	}
}

function mapFileStatements(
	resources: SourceMapped,
	fileCoverage: RawCoverageData[string],
	pending: Map<string, Map<string, PendingStatement>>,
): Set<string> {
	const resolvedTsPaths = new Set<string>();

	for (const [statementId, rawSpan] of Object.entries(resources.coverageMap.statementMap)) {
		const span = spanSchema(rawSpan);
		if (span instanceof type.errors) {
			continue;
		}

		const hitCount = fileCoverage.s[statementId] ?? 0;

		const mapped = mapStatement(resources.traceMap, span);
		if (mapped === undefined) {
			continue;
		}

		resolvedTsPaths.add(mapped.start.source);
		addOrCoalesce(pending, mapped.start, mapped.end, hitCount);
	}

	return resolvedTsPaths;
}

function mapFileFunctions(
	resources: SourceMapped,
	fileCoverage: RawCoverageData[string],
	pendingFunctions: Map<string, Array<PendingFunction>>,
	resolvedTsPaths: Set<string>,
): void {
	if (resources.coverageMap.functionMap === undefined) {
		return;
	}

	for (const [functionId, rawEntry] of Object.entries(resources.coverageMap.functionMap)) {
		const entry = functionEntrySchema(rawEntry);
		if (entry instanceof type.errors) {
			continue;
		}

		const hitCount = fileCoverage.f?.[functionId] ?? 0;

		const mapped = mapStatement(resources.traceMap, entry.location);

		if (mapped !== undefined) {
			const tsPath = mapped.start.source;
			let fileFunctions = pendingFunctions.get(tsPath);
			if (fileFunctions === undefined) {
				fileFunctions = [];
				pendingFunctions.set(tsPath, fileFunctions);
			}

			fileFunctions.push({
				name: entry.name,
				hitCount,
				loc: {
					end: { column: mapped.end.column, line: mapped.end.line },
					start: { column: mapped.start.column, line: mapped.start.line },
				},
			});
			continue;
		}

		// Function location couldn't be source-mapped — fall back to
		// the TS path inferred from successfully-mapped statements so
		// the function still appears in % Funcs (typically uncovered).
		// Picks the first resolved path; roblox-ts emits one .luau per
		// .ts file so multi-source is not expected in practice.
		const fallbackPath = resolvedTsPaths.values().next().value;
		if (fallbackPath === undefined) {
			continue;
		}

		let fileFunctions = pendingFunctions.get(fallbackPath);
		if (fileFunctions === undefined) {
			fileFunctions = [];
			pendingFunctions.set(fallbackPath, fileFunctions);
		}

		// Use line 1, column 0 — Istanbul consumers expect 1-based
		// lines; line 0 may render oddly in HTML/lcov reporters.
		fileFunctions.push({
			name: entry.name,
			hitCount,
			loc: {
				end: { column: 0, line: 1 },
				start: { column: 0, line: 1 },
			},
		});
	}
}

function mapBranchArmLocations(
	traceMap: TraceMap,
	rawLocations: Array<Record<string, unknown>>,
): MappedArmLocations | undefined {
	const mappedLocations: MappedArmLocations["locations"] = [];
	let tsPath: string | undefined;

	for (const rawLocation of rawLocations) {
		const location = spanSchema(rawLocation);
		if (location instanceof type.errors) {
			return undefined;
		}

		const mapped = mapStatement(traceMap, location);
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

	if (tsPath === undefined || mappedLocations.length === 0) {
		return undefined;
	}

	return { locations: mappedLocations, tsPath };
}

function mapFileBranches(
	resources: SourceMapped,
	fileCoverage: RawCoverageData[string],
	pendingBranches: Map<string, Array<PendingBranch>>,
): void {
	if (resources.coverageMap.branchMap === undefined) {
		return;
	}

	for (const [branchId, rawEntry] of Object.entries(resources.coverageMap.branchMap)) {
		const entry = branchEntrySchema(rawEntry);
		if (entry instanceof type.errors) {
			continue;
		}

		const armHitCounts = fileCoverage.b?.[branchId] ?? [];

		const result = mapBranchArmLocations(resources.traceMap, entry.locations);
		if (result === undefined) {
			continue;
		}

		let fileBranches = pendingBranches.get(result.tsPath);
		if (fileBranches === undefined) {
			fileBranches = [];
			pendingBranches.set(result.tsPath, fileBranches);
		}

		const firstLocation = result.locations[0];
		const lastLocation = result.locations[result.locations.length - 1];
		assert(
			firstLocation !== undefined && lastLocation !== undefined,
			"Branch locations must not be empty after successful mapping",
		);

		fileBranches.push({
			armHitCounts: entry.locations.map((_, index) => armHitCounts[index] ?? 0),
			loc: {
				end: lastLocation.end,
				start: firstLocation.start,
			},
			locations: result.locations,
			type: entry.type,
		});
	}
}

// --- Result building ---

function populateStatements(
	file: MappedFileCoverage,
	statementMap: Map<string, PendingStatement> | undefined,
): void {
	if (statementMap === undefined) {
		return;
	}

	let index = 0;
	for (const statement of statementMap.values()) {
		const id = String(index);
		file.statementMap[id] = {
			end: statement.end,
			start: statement.start,
		};
		file.s[id] = statement.hitCount;
		index++;
	}
}

function populateFunctions(
	file: MappedFileCoverage,
	fileFunctions: Array<PendingFunction> | undefined,
): void {
	if (fileFunctions === undefined) {
		return;
	}

	let functionIndex = 0;
	for (const func of fileFunctions) {
		const id = String(functionIndex);
		file.fnMap[id] = { name: func.name, loc: func.loc };
		file.f[id] = func.hitCount;
		functionIndex++;
	}
}

function populateBranches(
	file: MappedFileCoverage,
	fileBranches: Array<PendingBranch> | undefined,
): void {
	if (fileBranches === undefined) {
		return;
	}

	let branchIndex = 0;
	for (const branch of fileBranches) {
		const id = String(branchIndex);
		file.branchMap[id] = {
			loc: branch.loc,
			locations: branch.locations,
			type: branch.type,
		};
		file.b[id] = branch.armHitCounts;
		branchIndex++;
	}
}

function buildResult(
	pending: Map<string, Map<string, PendingStatement>>,
	pendingFunctions: Map<string, Array<PendingFunction>>,
	pendingBranches: Map<string, Array<PendingBranch>>,
): MappedCoverageResult {
	const files: Record<string, MappedFileCoverage> = {};

	// Collect all TS paths from statements, functions, and branches
	const allPaths = new Set([
		...pending.keys(),
		...pendingFunctions.keys(),
		...pendingBranches.keys(),
	]);

	for (const tsPath of allPaths) {
		const file: MappedFileCoverage = {
			b: {},
			branchMap: {},
			f: {},
			fnMap: {},
			path: tsPath,
			s: {},
			statementMap: {},
		};

		populateStatements(file, pending.get(tsPath));
		populateFunctions(file, pendingFunctions.get(tsPath));
		populateBranches(file, pendingBranches.get(tsPath));

		files[tsPath] = file;
	}

	return { files };
}
