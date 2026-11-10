import { runTaskPool } from "@isentinel/roblox-runner";
import type { ScriptResult } from "@isentinel/roblox-runner";

import process from "node:process";

import type { StreamingResultReader } from "../memory-store/sorted-map-client.ts";
import type { StreamingResultEntry } from "../protocol/streaming-summary.ts";
import {
	generateMaterializerScript,
	type MaterializerInput,
} from "../runner-payload/materializer-script.ts";
import { isEnvelopeDeferred } from "./envelope.ts";
import type { CollectedEntries } from "./open-cloud-entries.ts";
import { addEntriesToMap, parseStealingEnvelope } from "./open-cloud-entries.ts";
import { describeError } from "./open-cloud-failures.ts";

const STREAM_POLL_MS = 250;

/** Callbacks that receive work-stealing results while the run continues. */
export interface StreamingHooks {
	/** Receives each new entry; StreamingAggregator drops the duplicates. */
	onPackageResult: (entry: StreamingResultEntry) => void;
	/** Reader that polls the SortedMap of streamed results. */
	reader: StreamingResultReader;
}

interface PollState {
	warned: boolean;
}

interface StealingPoolOutcome {
	failure?: { error: Error };
	results: Array<ScriptResult>;
}

/**
 * Run one bucket's materializer entries, re-sending a script for whatever its
 * task deferred.
 *
 * @param options - The bucket's entries, the bail flag, and the task runner.
 * @returns Collected entries by job index, and whether any task bailed.
 */
export async function drainDeferralsAsync({
	bail,
	entries,
	runScript,
}: {
	readonly bail: boolean;
	readonly entries: Array<MaterializerInput>;
	readonly runScript: (script: string) => Promise<ScriptResult>;
}): Promise<{ bailed: boolean; collected: CollectedEntries }> {
	const collected: CollectedEntries = new Map();
	let remaining = entries;
	let hasBailed = false;

	while (remaining.length > 0) {
		const script = generateMaterializerScript(remaining, { bail });
		const envelope = parseStealingEnvelope(await runScript(script));
		addEntriesToMap({
			collected,
			entries: envelope.entries,
			gameOutput: envelope.gameOutput,
		});
		hasBailed ||= envelope.bailed;
		if (!envelope.deferred) {
			break;
		}

		const outstanding = remaining.filter(({ config }) => !collected.has(config.runnerJobIndex));
		remaining = outstanding.length === remaining.length ? [] : outstanding;
	}

	return { bailed: hasBailed, collected };
}

/**
 * Run the work-stealing task wave and poll the streaming map alongside it.
 *
 * @param options - Task runner, task count, key count, and streaming hooks.
 * @returns Every task's result.
 * @rejects The first task failure.
 */
export async function drainStealingPoolAsync({
	requiredKeyCount,
	runTask,
	streaming,
	taskCount,
}: {
	readonly requiredKeyCount: number;
	readonly runTask: () => Promise<ScriptResult>;
	readonly streaming: StreamingHooks | undefined;
	readonly taskCount: number;
}): Promise<Array<ScriptResult>> {
	const tasksDone = { value: false };
	const outcome: StealingPoolOutcome = { results: [] };
	const poolPromise = runStealingTasksAsync({
		jobCount: requiredKeyCount,
		outcome,
		runTask,
		taskCount,
	}).finally(() => {
		tasksDone.value = true;
	});

	const pollPromise =
		streaming !== undefined
			? pollStreamingResultsAsync(streaming, () => tasksDone.value)
			: Promise.resolve();

	await Promise.all([poolPromise, pollPromise]);

	if (outcome.failure !== undefined) {
		throw outcome.failure.error;
	}

	return outcome.results;
}

function warnStreamingDisabled(err: unknown, state: PollState): void {
	if (state.warned) {
		return;
	}

	state.warned = true;
	process.stderr.write(`Warning: live per-package streaming disabled — ${describeError(err)}\n`);
	process.stderr.write("  Tests still run; results print as usual once each task finishes.\n");
}

async function drainOnceAsync(hooks: StreamingHooks, state: PollState): Promise<void> {
	let records;
	try {
		records = await hooks.reader.readAllAsync();
	} catch (err) {
		warnStreamingDisabled(err, state);
		return;
	}

	for (const record of records) {
		hooks.onPackageResult(record.value);
	}

	await Promise.all(
		records.map(async (record) => {
			try {
				await hooks.reader.deleteAsync(record.id);
			} catch (err) {
				warnStreamingDisabled(err, state);
			}
		}),
	);
}

async function sleepAsync(ms: number): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function pollStreamingResultsAsync(
	hooks: StreamingHooks,
	isDone: () => boolean,
): Promise<void> {
	const state: PollState = { warned: false };

	while (!isDone()) {
		await drainOnceAsync(hooks, state);
		await sleepAsync(STREAM_POLL_MS);
	}

	await drainOnceAsync(hooks, state);
}

async function runStealingTasksAsync({
	jobCount,
	outcome,
	runTask,
	taskCount,
}: {
	readonly jobCount: number;
	readonly outcome: StealingPoolOutcome;
	readonly runTask: () => Promise<ScriptResult>;
	readonly taskCount: number;
}): Promise<void> {
	let launched = 0;
	let pendingDeferrals = 0;
	const maxLaunches = taskCount + jobCount;

	await runTaskPool({
		concurrency: taskCount,
		isDone: () => launched >= taskCount && (pendingDeferrals === 0 || launched >= maxLaunches),
		onError: (error) => {
			// runTaskPool resolves past a failed task; keep it to rethrow later.
			outcome.failure = { error };
		},
		onResult: (result) => {
			outcome.results.push(result);

			const jestOutput = result.outputs[0];
			if (jestOutput !== undefined && isEnvelopeDeferred(jestOutput)) {
				pendingDeferrals += 1;
			}
		},
		places: [
			{
				runTask: async () => {
					if (pendingDeferrals > 0) {
						pendingDeferrals -= 1;
					}

					launched += 1;
					return runTask();
				},
			},
		],
	});
}
