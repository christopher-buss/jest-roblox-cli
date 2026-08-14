import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";

import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { CoverageMap, SourceLocation } from "./coverage-map.ts";
import { readCoverageMap } from "./coverage-map.ts";
import type { CoverageManifest } from "./manifest.ts";
import type { RawCoverageData } from "./types.ts";

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

/**
 * One source file's statements, grouped by start line. Coalescing compares a
 * new statement against the entries on its own line only, which keeps the
 * lookup off the file's few thousand statements.
 */
type FileStatements = Map<number, Array<PendingStatement>>;

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

/** A Luau span carried back to the TypeScript source it came from. */
interface MappedSpan {
	end: MappedPosition;
	start: MappedPosition;
}

interface AddOrCoalesceOptions {
	hitCount: number;
	pending: Map<string, FileStatements>;
	span: MappedSpan;
}

interface FileResources {
	coverageMap: CoverageMap;
	sourceKey: string;
	/**
	 * Directory containing the source map, used to resolve relative source
	 * paths.
	 */
	sourceMapDirectory: string;
	traceMap: TraceMap | undefined;
}

interface MappedArmLocations {
	locations: Array<{
		end: { column: number; line: number };
		start: { column: number; line: number };
	}>;
	tsPath: string;
}

interface PushPendingBranchOptions {
	armHitCounts: Array<number>;
	/** Names the caller's own "locations are non-empty here" invariant. */
	emptyMessage: string;
	entry: { locations: ReadonlyArray<SourceLocation>; type: string };
	fileBranches: Array<PendingBranch>;
	locations: PendingBranch["locations"];
}

interface SourceMapped {
	coverageMap: FileResources["coverageMap"];
	sourceMapDirectory: string;
	traceMap: TraceMap;
}

/**
 * Thrown when a coverage map sidecar is present on disk but cannot be parsed or
 * validated. Silently skipping these files would let coverage thresholds pass
 * on incomplete data — the exact silent-breakage failure mode this guard is
 * meant to eliminate.
 */
export class CoverageMapMalformedError extends Error {
	public readonly coverageMapPath: string;

	constructor(coverageMapPath: string) {
		super(
			`Coverage map at ${coverageMapPath} is malformed or invalid (re-run \`jest-roblox instrument\`)`,
		);
		this.coverageMapPath = coverageMapPath;
	}
}

export function mapCoverageToTypeScript(
	coverageData: RawCoverageData,
	manifest: CoverageManifest,
): MappedCoverageResult {
	const pendingStatements = new Map<string, FileStatements>();
	const pendingFunctions = new Map<string, Array<PendingFunction>>();
	const pendingBranches = new Map<string, Array<PendingBranch>>();

	// The manifest is the report universe: every instrumented file is reported,
	// using runtime hits where a test exercised the file and zero-filling where
	// none did. Keying off the runtime hit map instead would silently omit
	// untested files, letting them slip past `coverageThreshold`.
	for (const [fileKey, record] of Object.entries(manifest.files)) {
		const fileCoverage = coverageData[fileKey] ?? { s: {} };

		const resources = loadFileResources(record);
		if (resources === undefined) {
			continue;
		}

		if (resources.traceMap === undefined) {
			passthroughFileStatements(resources, fileCoverage, pendingStatements);
			passthroughFileFunctions(resources, fileCoverage, pendingFunctions);
			passthroughFileBranches(resources, fileCoverage, pendingBranches);
		} else {
			const mapped = {
				coverageMap: resources.coverageMap,
				sourceMapDirectory: resources.sourceMapDirectory,
				traceMap: resources.traceMap,
			};
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
	const result = readCoverageMap(record.coverageMapPath);
	// File missing → silent skip (stale cache, will be regenerated).
	// File present-but-unreadable → throw, so callers don't compute reports
	// or enforce thresholds on incomplete data.
	if (result.kind === "missing") {
		return undefined;
	}

	if (result.kind === "invalid") {
		throw new CoverageMapMalformedError(record.coverageMapPath);
	}

	let traceMap: TraceMap | undefined;
	try {
		const sourceMapRaw = fs.readFileSync(record.sourceMapPath, "utf-8");
		traceMap = new TraceMap(sourceMapRaw);
	} catch {
		// No source map — native Luau file, passthrough mode
	}

	const sourceMapDirectory = path.posix.dirname(record.sourceMapPath);

	return {
		coverageMap: result.map,
		sourceKey: record.key,
		sourceMapDirectory,
		traceMap,
	};
}

// --- Passthrough helpers for native Luau (no source map) ---

function toIstanbulColumn(luauColumn: number): number {
	return Math.max(0, luauColumn - 1);
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
	let value = map.get(key);
	if (value === undefined) {
		value = create();
		map.set(key, value);
	}

	return value;
}

/** Get the list entries under `key` accumulate into, creating it on demand. */
function pendingListFor<K, T>(pending: Map<K, Array<T>>, key: K): Array<T> {
	return getOrCreate(pending, key, () => []);
}

function passthroughFileStatements(
	resources: FileResources,
	fileCoverage: RawCoverageData[string],
	pending: Map<string, FileStatements>,
): void {
	const fileStatements = getOrCreate(pending, resources.sourceKey, () => new Map());

	for (const [statementId, span] of Object.entries(resources.coverageMap.statementMap)) {
		const statement: PendingStatement = {
			end: { column: toIstanbulColumn(span.end.column), line: span.end.line },
			hitCount: fileCoverage.s[statementId] ?? 0,
			start: { column: toIstanbulColumn(span.start.column), line: span.start.line },
		};
		pendingListFor(fileStatements, statement.start.line).push(statement);
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

	const fileFunctions = pendingListFor(pendingFunctions, resources.sourceKey);

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

/**
 * Record one branch, spanning its arms from the first arm's start to the last
 * arm's end. `emptyMessage` names the caller's own invariant, since the two
 * callers reach a non-empty `locations` by different routes.
 */
function pushPendingBranch({
	armHitCounts,
	emptyMessage,
	entry,
	fileBranches,
	locations,
}: PushPendingBranchOptions): void {
	const firstLocation = locations[0];
	const lastLocation = locations.at(-1);
	assert(firstLocation !== undefined && lastLocation !== undefined, emptyMessage);

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

// --- Source-mapped helpers (roblox-ts → TypeScript) ---

function passthroughFileBranches(
	resources: FileResources,
	fileCoverage: RawCoverageData[string],
	pendingBranches: Map<string, Array<PendingBranch>>,
): void {
	if (resources.coverageMap.branchMap === undefined) {
		return;
	}

	const fileBranches = pendingListFor(pendingBranches, resources.sourceKey);

	for (const [branchId, entry] of Object.entries(resources.coverageMap.branchMap)) {
		const armHitCounts = fileCoverage.b?.[branchId] ?? [];
		const locations = toIstanbulLocations(entry.locations);
		if (locations.length === 0) {
			continue;
		}

		pushPendingBranch({
			armHitCounts,
			emptyMessage: "Branch locations must not be empty after filtering",
			entry,
			fileBranches,
			locations,
		});
	}
}

/**
 * Resolves a source path from a source map against the source map's directory.
 * Source maps produce paths relative to the .map file (e.g.,
 * `../../../packages/src/file.ts` from `out/packages/src/file.lua.map`).
 * Joining with the map directory normalizes these to cwd-relative paths.
 * Paths that are already cwd-relative (no `..` prefix) pass through unchanged.
 */
function resolveSourcePath(source: string, sourceMapDirectory: string): string {
	const normalized = normalizeWindowsPath(source);
	if (!normalized.startsWith("..")) {
		return normalized;
	}

	return path.posix.normalize(path.posix.join(sourceMapDirectory, normalized));
}

function mapStatement(
	traceMap: TraceMap,
	span: { end: { column: number; line: number }; start: { column: number; line: number } },
	sourceMapDirectory: string,
): MappedSpan | undefined {
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

	return a.column >= b.column ? a : b;
}

/**
 * Finds the entry on `sameLine` that a newly mapped statement belongs to, if
 * any.
 *
 * One TypeScript statement lowers to several Luau statements — a destructuring
 * declaration becomes `local _binding = ...` plus one statement per bound name,
 * and a nested expression is hoisted into its own temporary — each mapped to a
 * different column of the same source line. Istanbul counts one entry per
 * *source* statement, so keying on the exact start position alone inflates the
 * statement total and splits the hit count across fragments that sit in
 * different basic blocks: the outer fragment runs, an inner one does not, and
 * the line reports as partially covered although the source statement ran.
 *
 * Sharing a start line is therefore the rule, qualified by one of the two spans
 * covering several lines — that span is the enclosing statement, so the pair
 * cannot be two single-line statements that merely share a line. The
 * qualification is a heuristic, not a parse: distinct single-line statements
 * sharing a line with a multi-line one do get merged. Ruling that out needs the
 * enclosing source statement's range, which a source map does not carry — the
 * mapped end position is the nearest preceding segment, not the statement's
 * true end, so testing containment instead would miss real fragments.
 */
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
	// Partitioned by tsPath, so equal positions in different source files
	// cannot collide.
	const fileStatements = getOrCreate(pending, start.source, () => new Map());
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
	// Widen leftwards only. The start line matches by construction, so this
	// moves a column and the grouping stays valid.
	if (start.column < existing.start.column) {
		existing.start.column = start.column;
	}
}

function mapFileStatements(
	resources: SourceMapped,
	fileCoverage: RawCoverageData[string],
	pending: Map<string, FileStatements>,
): Set<string> {
	const resolvedTsPaths = new Set<string>();

	for (const [statementId, span] of Object.entries(resources.coverageMap.statementMap)) {
		const hitCount = fileCoverage.s[statementId] ?? 0;

		const mapped = mapStatement(resources.traceMap, span, resources.sourceMapDirectory);
		if (mapped === undefined) {
			continue;
		}

		resolvedTsPaths.add(mapped.start.source);
		addOrCoalesce({ hitCount, pending, span: mapped });
	}

	return resolvedTsPaths;
}

/**
 * Function location couldn't be source-mapped — fall back to the TS path
 * inferred from successfully-mapped statements so the function still appears in
 * % Funcs (typically uncovered). Picks the first resolved path; roblox-ts emits
 * one .luau per .ts file so multi-source is not expected in practice.
 */
function addUnmappedFunction(
	pendingFunctions: Map<string, Array<PendingFunction>>,
	resolvedTsPaths: Set<string>,
	name: string,
	hitCount: number,
): void {
	const fallbackPath = resolvedTsPaths.values().next().value;
	if (fallbackPath === undefined) {
		return;
	}

	// Use line 1, column 0 — Istanbul consumers expect 1-based lines; line 0 may
	// render oddly in HTML/lcov reporters.
	pendingListFor(pendingFunctions, fallbackPath).push({
		name,
		hitCount,
		loc: {
			end: { column: 0, line: 1 },
			start: { column: 0, line: 1 },
		},
	});
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

	for (const [functionId, entry] of Object.entries(resources.coverageMap.functionMap)) {
		const hitCount = fileCoverage.f?.[functionId] ?? 0;

		const mapped = mapStatement(
			resources.traceMap,
			entry.location,
			resources.sourceMapDirectory,
		);

		if (mapped === undefined) {
			addUnmappedFunction(pendingFunctions, resolvedTsPaths, entry.name, hitCount);
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

function mapBranchArmLocations(
	traceMap: TraceMap,
	locations: ReadonlyArray<SourceLocation>,
	sourceMapDirectory: string,
): MappedArmLocations | undefined {
	const mappedLocations: MappedArmLocations["locations"] = [];
	let tsPath: string | undefined;

	for (const location of locations) {
		const mapped = mapStatement(traceMap, location, sourceMapDirectory);
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

/**
 * Detects a phantom branch arm produced by a source-less synthetic statement
 * `if` (e.g. a roblox-ts Array polyfill like `.filter`/`.includes`). The
 * synthetic `if` has no source map entry, so trace-mapping's greatest-lower-
 * bound bias snaps both arms onto the nearest preceding segment — the then-
 * arm's own start — yielding a zero-width arm that coincides with another
 * arm's start and can never be covered.
 *
 * A genuine statement `if` is safe: roblox-ts always renders it multi-line, so
 * the then-body (generated line `if+1`) and the implicit-else arm (generated
 * line `if`) carry distinct source-map segments and never collapse. This is
 * gated to `type === "if"` by the caller: a single-line `expr-if` (ternary)
 * legitimately collapses to one column-0 segment and must NOT be dropped.
 */
function hasCollapsedPhantomArm(locations: MappedArmLocations["locations"]): boolean {
	return locations.some((arm, index) => {
		const isZeroWidth = arm.start.line === arm.end.line && arm.start.column === arm.end.column;
		if (!isZeroWidth) {
			return false;
		}

		return locations.some((other, otherIndex) => {
			return (
				otherIndex !== index &&
				other.start.line === arm.start.line &&
				other.start.column === arm.start.column
			);
		});
	});
}

function mapFileBranches(
	resources: SourceMapped,
	fileCoverage: RawCoverageData[string],
	pendingBranches: Map<string, Array<PendingBranch>>,
): void {
	if (resources.coverageMap.branchMap === undefined) {
		return;
	}

	for (const [branchId, entry] of Object.entries(resources.coverageMap.branchMap)) {
		const armHitCounts = fileCoverage.b?.[branchId] ?? [];

		const result = mapBranchArmLocations(
			resources.traceMap,
			entry.locations,
			resources.sourceMapDirectory,
		);
		if (result === undefined) {
			continue;
		}

		// Drop source-less synthetic polyfill `if`s whose arms collapsed onto a
		// single point. Scoped to statement `if`s — a real `expr-if` (ternary)
		// legitimately collapses to one column-0 segment and must be kept.
		if (entry.type === "if" && hasCollapsedPhantomArm(result.locations)) {
			continue;
		}

		pushPendingBranch({
			armHitCounts,
			emptyMessage: "Branch locations must not be empty after successful mapping",
			entry,
			fileBranches: pendingListFor(pendingBranches, result.tsPath),
			locations: result.locations,
		});
	}
}

// --- Result building ---

function populateStatements(
	file: MappedFileCoverage,
	fileStatements: FileStatements | undefined,
): void {
	if (fileStatements === undefined) {
		return;
	}

	let index = 0;
	for (const lineStatements of fileStatements.values()) {
		for (const statement of lineStatements) {
			const id = String(index);
			file.statementMap[id] = {
				end: statement.end,
				start: statement.start,
			};
			file.s[id] = statement.hitCount;
			index++;
		}
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
	pending: Map<string, FileStatements>,
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
