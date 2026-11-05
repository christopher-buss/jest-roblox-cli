import type { ScriptResult } from "@isentinel/roblox-runner";

import type { Except } from "type-fest";

import type { DecodedEnvelope } from "./envelope.ts";
import { decodeEnvelope } from "./envelope.ts";
import type { BackendResult, EnvelopeEntry, ProjectJob, RawBackendEntry } from "./interface.ts";

/** One package's entry plus the task-level game output it arrived with. */
export interface CollectedEntry {
	/** Envelope entry of the package. */
	entry: EnvelopeEntry;
	/** Game output of the task that returned the entry. */
	gameOutput: string | undefined;
}

/** What one dispatch produced, minus the timing the caller measures itself. */
export type DispatchOutcome = Except<BackendResult, "timing">;

/** A decoded work-stealing envelope with its task game output. */
interface StealingEnvelope extends DecodedEnvelope {
	/** Game output of the task. */
	gameOutput: string | undefined;
}

/**
 * Key that matches an envelope entry to its job.
 * @param packageName - Package that owns the entry.
 * @param project - Project name inside the package.
 * @returns The package name, or `package::project` when the two differ.
 */
export function entryLookupKey(packageName: string, project: string | undefined): string {
	return project === undefined || project === packageName
		? packageName
		: `${packageName}::${project}`;
}

/**
 * Pair every job with its aggregated entry, in request order.
 *
 * A gap normally means a task broke and lost its results, so they are collected
 * and one failure message names them all rather than failing on the first.
 * Under `--bail` the gaps are the point: the run stopped on a failing package
 * and the ones after it were never meant to run, so they come back reported as
 * bailed instead.
 *
 * That trade is real — once any task reports a bail, a sibling that lost
 * results some other way is reported as deliberately skipped too. Nothing here
 * can tell the two apart: every caller runs its tasks concurrently, so "after
 * the failing package" names no set. A task that dies outright still fails the
 * run through the pool's captured error; what this gives up is the narrower
 * case of a task that returns successfully having lost entries.
 * @param options - Bail flag, collected entries and the requested jobs.
 * @returns Raw results in job order, plus bailed indices under `--bail`.
 */
export function collectStealingResults({
	bailed,
	entryByKey,
	jobs,
}: {
	/** True when any task reported a bail. */
	bailed: boolean;
	/** Collected entries keyed by `entryLookupKey`. */
	entryByKey: Map<string, CollectedEntry>;
	/** Jobs of the run, in request order. */
	jobs: Array<ProjectJob>;
}): DispatchOutcome {
	const bailedJobIndices: Array<number> = [];
	const missingJobNames: Array<string> = [];
	const rawResults: Array<RawBackendEntry> = [];
	for (const [index, job] of jobs.entries()) {
		const found = entryByKey.get(entryLookupKey(job.pkg ?? job.displayName, job.displayName));
		if (found === undefined) {
			bailedJobIndices.push(index);
			missingJobNames.push(job.displayName);
			continue;
		}

		rawResults.push({ entry: found.entry, fallbackGameOutput: found.gameOutput });
	}

	if (bailed) {
		return { bailedJobIndices, rawResults };
	}

	if (bailedJobIndices.length > 0) {
		throw new Error(
			`Open Cloud returned no entries for ${bailedJobIndices.length.toString()} package(s): ${missingJobNames.join(", ")}`,
		);
	}

	return { rawResults };
}

/**
 * Decode one task's return envelope. Throws when the task produced no Jest
 * output so a broken task surfaces as a run failure rather than a
 * silently-missing package.
 * @param result - Result of one finished task.
 * @returns Decoded envelope plus the task game output.
 */
export function parseStealingEnvelope(result: ScriptResult): StealingEnvelope {
	return { ...decodeEnvelope(requireJestOutput(result)), gameOutput: result.outputs[1] };
}

/**
 * Add each package entry to the map unless its key is already present.
 * @param options - Entries, target map and the task game output.
 */
export function addEntriesToMap({
	entries,
	entryByKey,
	gameOutput,
}: {
	/** Entries to add; entries without `pkg` are skipped. */
	readonly entries: Array<EnvelopeEntry>;
	/** Map to fill, keyed by `entryLookupKey`. */
	readonly entryByKey: Map<string, CollectedEntry>;
	/** Game output of the task that returned the entries. */
	readonly gameOutput: string | undefined;
}): void {
	for (const entry of entries) {
		if (entry.pkg === undefined) {
			continue;
		}

		const key = entryLookupKey(entry.pkg, entry.project);
		if (!entryByKey.has(key)) {
			entryByKey.set(key, { entry, gameOutput });
		}
	}
}

/**
 * Aggregate entries from all task envelopes. Map by pkg::project so
 * multi-project packages don't collide on a shared `pkg`. The first
 * observed entry per key wins; subsequent duplicates (from fault-
 * recovery re-runs after invisibility timeout) are dropped.
 * @param taskEnvelopes - Decoded envelopes of every task.
 * @returns Collected entries keyed by `entryLookupKey`.
 */
export function aggregateEntriesByKey(
	taskEnvelopes: ReadonlyArray<{
		/** Entries the task returned. */
		entries: Array<EnvelopeEntry>;
		/** Game output of the task. */
		gameOutput: string | undefined;
	}>,
): Map<string, CollectedEntry> {
	const entryByKey = new Map<string, CollectedEntry>();
	for (const { entries, gameOutput } of taskEnvelopes) {
		addEntriesToMap({ entries, entryByKey, gameOutput });
	}

	return entryByKey;
}

/**
 * The Jest envelope a task returned, or a failure naming what came back.
 * @param result - Result of one finished task.
 * @returns First output of the task.
 */
function requireJestOutput(result: ScriptResult): string {
	const jestOutput = result.outputs[0];
	if (jestOutput === undefined) {
		throw new Error(`No test results in output. Got: ${JSON.stringify(result.outputs)}`);
	}

	return jestOutput;
}
