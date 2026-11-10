import assert from "node:assert";

import type { SourceLocation } from "../coverage-data/coverage-map.ts";
import type {
	FileStatements,
	MappedCoverageResult,
	MappedFileCoverage,
	PendingBranch,
	PendingCoverage,
	PendingFunction,
} from "./mapper-types.ts";

interface PushPendingBranchOptions {
	armHitCounts: Array<number>;
	entry: { locations: ReadonlyArray<SourceLocation>; type: string };
	fileBranches: Array<PendingBranch>;
	locations: PendingBranch["locations"];
}

/**
 * Start an empty per-file accumulation of mapped hits.
 * @returns Empty statement, function and branch maps.
 */
export function createPendingCoverage(): PendingCoverage {
	return { branches: new Map(), functions: new Map(), statements: new Map() };
}

/**
 * Get the list entries under `key` accumulate into, creating it on demand.
 * @template K - Map key.
 * @template T - List entry.
 * @param pending - Lists keyed by file.
 * @param key - File whose list is wanted.
 * @returns The list stored under `key`.
 */
export function pendingListFor<K, T>(pending: Map<K, Array<T>>, key: K): Array<T> {
	return getOrCreate({ key, create: () => [], map: pending });
}

/**
 * Get the statements recorded for one file, creating the map on demand.
 * @param pending - Statement maps keyed by file.
 * @param key - File whose statements are wanted.
 * @returns The statement map stored under `key`.
 */
export function fileStatementsFor(
	pending: Map<string, FileStatements>,
	key: string,
): FileStatements {
	return getOrCreate({ key, create: (): FileStatements => new Map(), map: pending });
}

/**
 * Record one branch spanning all its arms.
 * @param options - Arm hits, coverage-map entry, target list and arm spans.
 */
export function pushPendingBranch({
	armHitCounts,
	entry,
	fileBranches,
	locations,
}: PushPendingBranchOptions): void {
	const firstLocation = locations[0];
	const lastLocation = locations.at(-1);
	assert(firstLocation !== undefined && lastLocation !== undefined);

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

/**
 * Number pending coverage into Istanbul file records.
 * @param pending - Hits accumulated per file.
 * @returns One coverage record per file seen in any of the three maps.
 */
export function buildMappedResult({
	branches,
	functions,
	statements,
}: PendingCoverage): MappedCoverageResult {
	const files: Record<string, MappedFileCoverage> = {};

	const allPaths = new Set([...statements.keys(), ...functions.keys(), ...branches.keys()]);

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

		populateStatements(file, statements.get(tsPath));
		populateFunctions(file, functions.get(tsPath));
		populateBranches(file, branches.get(tsPath));

		files[tsPath] = file;
	}

	return { files };
}

function getOrCreate<K, V>({
	key,
	create,
	map,
}: {
	create: () => NoInfer<V>;
	key: K;
	map: Map<K, V>;
}): V {
	let value = map.get(key);
	if (value === undefined) {
		value = create();
		map.set(key, value);
	}

	return value;
}

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
