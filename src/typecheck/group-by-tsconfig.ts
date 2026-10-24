import { performance } from "node:perf_hooks";

import type { JestResult } from "../types/jest-result.ts";
import { isLuauTypeTestFile } from "./type-test-pattern.ts";

/**
 * One project's Type Test files plus the effective `(tsconfig, cwd)` they are
 * checked against. Also the shape handed to `run` per collapsed group.
 */
export interface TypecheckGroupEntry {
	cwd: string;
	files: Array<string>;
	tsconfig?: string | undefined;
}

export type RunTypecheckGroup = (group: TypecheckGroupEntry) => Promise<JestResult>;

/**
 * Outcome of one timed Type Test pass: the merged result (undefined when no
 * entry carried files) plus the wall-clock `elapsedMs` the caller records as
 * the `runTypecheck` span after the concurrency barrier.
 */
export interface TypecheckPassOutcome {
	elapsedMs: number;
	result?: JestResult | undefined;
}

interface GroupAccumulator {
	cwd: string;
	files: Set<string>;
	tsconfig?: string | undefined;
}

/**
 * Groups Type Test entries by their effective `(tsconfig, cwd)` (Luau files
 * by `cwd` alone) and runs one checker pass per distinct group via `run`, then
 * merges the per-group results into one. Projects sharing a group collapse to
 * a single pass; projects with distinct tsconfigs are each checked against
 * their own. Groups run concurrently. Returns undefined when no entry carries
 * any files.
 */
export async function groupTypecheckByTsconfig(
	entries: ReadonlyArray<TypecheckGroupEntry>,
	run: RunTypecheckGroup,
): Promise<JestResult | undefined> {
	async function toResult(group: GroupAccumulator): Promise<JestResult> {
		return run({
			cwd: group.cwd,
			files: [...group.files],
			tsconfig: group.tsconfig,
		});
	}

	const [firstGroup, ...otherGroups] = collectGroups(entries);
	if (firstGroup === undefined) {
		return undefined;
	}

	const results = await Promise.all([toResult(firstGroup), ...otherGroups.map(toResult)]);
	return mergeResults(results);
}

/**
 * Times a Type Test pass over `entries` — grouping them by `(cwd, tsconfig)`
 * and running each group via `run` — and returns the merged result with the
 * elapsed wall-clock. Returns `elapsedMs: 0` and no result for an empty
 * `entries`, so callers skip recording a zero span. Self-times with a plain
 * clock rather than the timing collector (its LIFO stack is not
 * concurrency-safe) because the pass runs concurrently with the Open Cloud
 * dispatch. The mode-specific policy (run-wide vs per-package) and any
 * per-group result post-processing live in the caller's `run` callback.
 */
export async function runTypecheckPassAsync(
	entries: ReadonlyArray<TypecheckGroupEntry>,
	run: RunTypecheckGroup,
): Promise<TypecheckPassOutcome> {
	if (entries.length === 0) {
		return { elapsedMs: 0 };
	}

	const start = performance.now();
	const result = await groupTypecheckByTsconfig(entries, run);
	return { elapsedMs: performance.now() - start, result };
}

// Collapses files sharing a Typecheck Group into one accumulator each, in
// first-seen order: `(cwd, tsconfig)` for TypeScript, `cwd` alone for Luau.
function collectGroups(entries: ReadonlyArray<TypecheckGroupEntry>): Array<GroupAccumulator> {
	const groups = new Map<string, GroupAccumulator>();
	for (const entry of entries) {
		for (const file of entry.files) {
			const tsconfig = isLuauTypeTestFile(file) ? undefined : entry.tsconfig;
			// JSON-encode the key so distinct groups never collide (a plain
			// delimiter could, e.g. for paths with the delimiter char).
			const key = JSON.stringify([isLuauTypeTestFile(file), entry.cwd, tsconfig ?? null]);
			let group = groups.get(key);
			if (group === undefined) {
				group = { cwd: entry.cwd, files: new Set(), tsconfig };

				groups.set(key, group);
			}

			group.files.add(file);
		}
	}

	return [...groups.values()];
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
