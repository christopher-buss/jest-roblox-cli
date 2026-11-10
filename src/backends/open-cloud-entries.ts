import type { ScriptResult } from "@isentinel/roblox-runner";

import type { Except } from "type-fest";

import type { WireEnvelopeEntry } from "../protocol/envelope.ts";
import type { DecodedEnvelope } from "./envelope.ts";
import { decodeEnvelope } from "./envelope.ts";
import type { BackendResult } from "./interface.ts";

/** Collected entries keyed by the job index each names. */
export type CollectedEntries = Map<number, CollectedEntry>;

/** What one dispatch produced, minus the timing the caller measures itself. */
export type DispatchOutcome = Except<BackendResult, "timing">;

/** One job's entry plus the task-level game output it arrived with. */
interface CollectedEntry {
	/** Envelope entry of the job. */
	entry: WireEnvelopeEntry;
	/** Game output of the task that returned the entry. */
	gameOutput: string | undefined;
}

interface StealingEnvelope extends DecodedEnvelope {
	gameOutput: string | undefined;
}

/**
 * The raw results of every collected entry.
 * @param bailed - True when any task reported a bail.
 * @param collected - Collected entries keyed by job index.
 * @returns Raw results, one per job that ran.
 */
export function toDispatchOutcome(bailed: boolean, collected: CollectedEntries): DispatchOutcome {
	const rawResults = Array.from(
		collected.values(),
		({ entry: { jobIndex, ...entry }, gameOutput }) => {
			return { entry, fallbackGameOutput: gameOutput, jobIndex };
		},
	);
	return { bailed, rawResults };
}

/**
 * Decode one task's return envelope.
 * @param result - Result of one finished task.
 * @returns Decoded envelope plus the task game output.
 */
export function parseStealingEnvelope(result: ScriptResult): StealingEnvelope {
	return { ...decodeEnvelope(requireJestOutput(result)), gameOutput: result.outputs[1] };
}

/**
 * Add each entry to the map unless its job already has one.
 * @param options - Entries, target map and the task game output.
 */
export function addEntriesToMap({
	collected,
	entries,
	gameOutput,
}: {
	/** Map to fill, keyed by job index. */
	readonly collected: CollectedEntries;
	/** Entries to add. */
	readonly entries: Array<WireEnvelopeEntry>;
	/** Game output of the task that returned the entries. */
	readonly gameOutput: string | undefined;
}): void {
	for (const entry of entries) {
		if (!collected.has(entry.jobIndex)) {
			collected.set(entry.jobIndex, { entry, gameOutput });
		}
	}
}

/**
 * Aggregate entries from all task envelopes; the first entry per job wins.
 * @param taskEnvelopes - Decoded envelopes of every task.
 * @returns Collected entries keyed by job index.
 */
export function aggregateEntriesByJob(
	taskEnvelopes: ReadonlyArray<{
		/** Entries the task returned. */
		entries: Array<WireEnvelopeEntry>;
		/** Game output of the task. */
		gameOutput: string | undefined;
	}>,
): CollectedEntries {
	const collected: CollectedEntries = new Map();
	for (const { entries, gameOutput } of taskEnvelopes) {
		addEntriesToMap({ collected, entries, gameOutput });
	}

	return collected;
}

function requireJestOutput(result: ScriptResult): string {
	const jestOutput = result.outputs[0];
	if (jestOutput === undefined) {
		throw new Error(`No test results in output. Got: ${JSON.stringify(result.outputs)}`);
	}

	return jestOutput;
}
