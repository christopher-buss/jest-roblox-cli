import type { JestResult } from "../types/jest-result.ts";

/**
 * One project's Type Test files plus the effective `(tsconfig, cwd)` they are
 * checked against. Also the shape handed to `run` per collapsed group.
 */
export interface TypecheckGroupEntry {
	cwd: string;
	files: Array<string>;
	tsconfig?: string;
}

export type RunTypecheckGroup = (group: TypecheckGroupEntry) => JestResult;

interface GroupAccumulator {
	cwd: string;
	files: Set<string>;
	tsconfig?: string;
}

/**
 * Groups Type Test entries by their effective `(tsconfig, cwd)` and runs one
 * tsgo pass per distinct group via `run`, then merges the per-group results into
 * one. Projects sharing a `(tsconfig, cwd)` collapse to a single pass; projects
 * with distinct tsconfigs are each checked against their own. Returns undefined
 * when no entry carries any files.
 */
export function groupTypecheckByTsconfig(
	entries: ReadonlyArray<TypecheckGroupEntry>,
	run: RunTypecheckGroup,
): JestResult | undefined {
	function toResult(group: GroupAccumulator): JestResult {
		return run({
			cwd: group.cwd,
			files: [...group.files],
			...(group.tsconfig !== undefined ? { tsconfig: group.tsconfig } : {}),
		});
	}

	const groups = new Map<string, GroupAccumulator>();
	for (const entry of entries) {
		if (entry.files.length === 0) {
			continue;
		}

		// JSON-encode the `(cwd, tsconfig)` pair so distinct pairs never collide
		// into one key (a plain delimiter could, e.g. for paths with the
		// delimiter char).
		const key = JSON.stringify([entry.cwd, entry.tsconfig ?? null]);
		let group = groups.get(key);
		if (group === undefined) {
			group = { cwd: entry.cwd, files: new Set() };
			if (entry.tsconfig !== undefined) {
				group.tsconfig = entry.tsconfig;
			}

			groups.set(key, group);
		}

		for (const file of entry.files) {
			group.files.add(file);
		}
	}

	const [firstGroup, ...otherGroups] = [...groups.values()];
	if (firstGroup === undefined) {
		return undefined;
	}

	return mergeResults([toResult(firstGroup), ...otherGroups.map(toResult)]);
}

function mergeResults(results: [JestResult, ...Array<JestResult>]): JestResult {
	return results.reduce((accumulator, current) => {
		return {
			numFailedTests: accumulator.numFailedTests + current.numFailedTests,
			numPassedTests: accumulator.numPassedTests + current.numPassedTests,
			numPendingTests: accumulator.numPendingTests + current.numPendingTests,
			numTotalTests: accumulator.numTotalTests + current.numTotalTests,
			startTime: Math.min(accumulator.startTime, current.startTime),
			success: accumulator.success && current.success,
			testResults: [...accumulator.testResults, ...current.testResults],
		};
	});
}
