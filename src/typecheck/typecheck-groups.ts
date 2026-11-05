import { performance } from "node:perf_hooks";
import process from "node:process";

import { ConfigError } from "../config/errors.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import { isLuauTypeTestFile } from "./type-test-pattern.ts";

/**
 * One project's Type Test files plus the effective `(tsconfig, cwd)` they are
 * checked against. Also the shape handed to `run` per collapsed group.
 */
export interface TypecheckGroupEntry {
	/** The working directory the files are checked from. */
	cwd: string;
	/** The Type Test files. */
	files: Array<string>;
	/** The tsconfig the TypeScript files are checked against. */
	tsconfig?: string | undefined;
}

/** Runs one Type Test pass over a collapsed group. */
export type RunTypecheckGroup = (group: TypecheckGroupEntry) => Promise<JestResult>;

/**
 * Outcome of one timed Type Test pass: the merged result (undefined when no
 * entry carried files) plus the wall-clock `elapsedMs` the caller records as
 * the `runTypecheck` span after the concurrency barrier.
 */
export interface TypecheckPassOutcome {
	/** Wall-clock duration of the pass, in milliseconds. */
	elapsedMs: number;
	/** The merged result of every group. */
	result?: JestResult | undefined;
}

interface GroupAccumulator {
	cwd: string;
	files: Set<string>;
	tsconfig?: string | undefined;
}

/**
 * Reject TypeScript Type Tests under the standalone binary, which cannot run
 * tsgo.
 * @param entries - The planned Type Test entries.
 * @throws {ConfigError} When running standalone with a TypeScript Type Test.
 */
export function assertTypecheckAvailable(entries: ReadonlyArray<TypecheckGroupEntry>): void {
	if (process.env["JEST_ROBLOX_SEA"] !== "true") {
		return;
	}

	const hasTypeScriptFile = entries.some(({ files }) => {
		return files.some((file) => !isLuauTypeTestFile(file));
	});
	if (hasTypeScriptFile) {
		throw new ConfigError(
			"--typecheck is not available in the standalone binary. Install via npm instead.",
		);
	}
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
 * @param entries - The Type Test entries to group.
 * @param run - Runs one group.
 * @returns The merged result and the elapsed wall-clock.
 * @rejects Whatever `run` rejects with.
 */
export async function runTypecheckPassAsync(
	entries: ReadonlyArray<TypecheckGroupEntry>,
	run: RunTypecheckGroup,
): Promise<TypecheckPassOutcome> {
	if (entries.length === 0) {
		return { elapsedMs: 0 };
	}

	const start = performance.now();
	const result = await groupTypecheckPassesAsync(entries, run);
	return { elapsedMs: performance.now() - start, result };
}

/**
 * Collapses files sharing a Typecheck Group into one accumulator each, in
 * first-seen order: `(cwd, tsconfig)` for TypeScript, `cwd` alone for Luau.
 * @param entries - The Type Test entries.
 * @returns One accumulator per group.
 */
function collectGroups(entries: ReadonlyArray<TypecheckGroupEntry>): Array<GroupAccumulator> {
	const groups = new Map<string, GroupAccumulator>();
	for (const entry of entries) {
		for (const file of entry.files) {
			const isLuau = isLuauTypeTestFile(file);
			const tsconfig = isLuau ? undefined : entry.tsconfig;
			// JSON-encode the key so distinct groups never collide (a plain
			// delimiter could, e.g. for paths with the delimiter char).
			const key = JSON.stringify([isLuau, entry.cwd, tsconfig ?? null]);
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

/**
 * Run one pass per Typecheck Group, concurrently, and merge the results.
 * @param entries - The Type Test entries to group.
 * @param run - Runs one group.
 * @returns The merged result, or `undefined` when no entry has files.
 * @rejects Whatever `run` rejects with.
 */
async function groupTypecheckPassesAsync(
	entries: ReadonlyArray<TypecheckGroupEntry>,
	run: RunTypecheckGroup,
): Promise<JestResult | undefined> {
	async function toResultAsync(group: GroupAccumulator): Promise<JestResult> {
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

	const results = await Promise.all([
		toResultAsync(firstGroup),
		...otherGroups.map(toResultAsync),
	]);
	return mergeResults(results);
}
