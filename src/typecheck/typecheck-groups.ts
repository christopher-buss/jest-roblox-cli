import assert from "node:assert";
import { performance } from "node:perf_hooks";

import { ConfigError } from "../config/errors.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import { mergeJestResults } from "../types/jest-result-merge.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import { isSeaBuild } from "../utils/sea.ts";
import { isLuauTypeTestFile } from "../utils/test-file-kind.ts";
import type { RunTypecheck, TypecheckOptions } from "./runner.ts";

/** Type Test files and the `(tsconfig, cwd)` they are checked against. */
export interface TypecheckGroupEntry {
	/** The working directory the files are checked from. */
	cwd: string;
	/** The Type Test files. */
	files: Array<string>;
	/** The tsconfig the TypeScript files are checked against. */
	tsconfig?: string | undefined;
}

/** Outcome of one timed Type Test pass. */
export interface TypecheckPassOutcome {
	/** Wall-clock duration of the pass, in milliseconds. */
	elapsedMs: number;
	/** The merged result of every group. */
	result?: JestResult | undefined;
}

/** Run-wide or per-package checker policy one group runs under. */
export type TypecheckGroupPolicy = Pick<
	TypecheckOptions,
	"ignoreSourceErrors" | "spawnTimeout" | "timeout"
>;

/** Runs one Type Test pass over a collapsed group. */
type RunTypecheckGroup = (group: TypecheckGroupEntry) => Promise<JestResult>;

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
	if (!isSeaBuild()) {
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
 * Run one grouped Type Test pass, each group under the policy of its cwd.
 * @template P - Policy record of the run's mode.
 * @param options - Entries, the policy per Type Test cwd, the checker and a
 *   per-group finisher.
 * @param options.entries - Type Test entries to group.
 * @param options.finishGroup - Rewrites one group's result before the merge.
 * @param options.policyByDirectory - Checker policy per Type Test cwd.
 * @param options.runTypecheck - Runs one tsgo pass.
 * @returns The merged result and the elapsed wall-clock.
 * @rejects When the checker fails.
 */
export async function runPolicyTypecheckPassAsync<P extends TypecheckGroupPolicy>({
	entries,
	finishGroup = (result) => result,
	policyByDirectory,
	runTypecheck,
}: {
	entries: ReadonlyArray<TypecheckGroupEntry>;
	finishGroup?: (result: JestResult, policy: P) => JestResult;
	policyByDirectory: ReadonlyMap<string, P>;
	runTypecheck: RunTypecheck;
}): Promise<TypecheckPassOutcome> {
	return runTypecheckPassAsync(entries, async (group) => {
		const policy = policyByDirectory.get(group.cwd);
		assert(policy !== undefined, `no Type Test policy for ${group.cwd}`);
		return finishGroup(await checkTypecheckGroupAsync({ group, policy, runTypecheck }), policy);
	});
}

/**
 * Record a finished Type Test pass as a root span.
 * @param timing - Profiler of the run.
 * @param outcome - The finished pass; its `elapsedMs` is the span length.
 */
export function recordTypecheckPass(timing: TimingCollector, outcome: TypecheckPassOutcome): void {
	if (outcome.elapsedMs > 0) {
		timing.record("runTypecheck", outcome.elapsedMs);
	}
}

function collectGroups(entries: ReadonlyArray<TypecheckGroupEntry>): Array<GroupAccumulator> {
	const groups = new Map<string, GroupAccumulator>();
	for (const entry of entries) {
		for (const file of entry.files) {
			const isLuau = isLuauTypeTestFile(file);
			const tsconfig = isLuau ? undefined : entry.tsconfig;
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

	const groups = collectGroups(entries);
	if (groups.length === 0) {
		return undefined;
	}

	const results = await Promise.all(groups.map(toResultAsync));
	return mergeJestResults(results);
}

/**
 * Time a grouped Type Test pass; a plain clock, as the collector's LIFO stack
 * is not concurrency-safe.
 * @param entries - The Type Test entries to group.
 * @param run - Runs one group.
 * @returns The merged result and the elapsed wall-clock.
 * @rejects Whatever `run` rejects with.
 */
async function runTypecheckPassAsync(
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

async function checkTypecheckGroupAsync({
	group,
	policy,
	runTypecheck,
}: {
	group: TypecheckGroupEntry;
	policy: TypecheckGroupPolicy;
	runTypecheck: RunTypecheck;
}): Promise<JestResult> {
	return runTypecheck({
		files: group.files,
		ignoreSourceErrors: policy.ignoreSourceErrors,
		rootDir: group.cwd,
		spawnTimeout: policy.spawnTimeout,
		timeout: policy.timeout,
		tsconfig: group.tsconfig,
	});
}
