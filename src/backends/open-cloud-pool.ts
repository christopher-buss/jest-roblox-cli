import { runTaskPool } from "@isentinel/roblox-runner";
import type { ScriptResult } from "@isentinel/roblox-runner";

import process from "node:process";

import { isEnvelopeDeferred } from "./envelope.ts";
import type { StreamingHooks } from "./interface.ts";
import { describeError } from "./open-cloud-failures.ts";

const DEFAULT_STREAM_POLL_MS = 250;

interface PollState {
	warned: boolean;
}

interface StealingPoolOutcome {
	failure?: { error: Error };
	results: Array<ScriptResult>;
}

/**
 * Run the work-stealing task wave and, when streaming is enabled, poll the
 * streaming map alongside it. Returns every task's result once the wave has
 * settled; rethrows the first task failure the pool folded into a freed slot.
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
	// A holder, not a plain boolean, so the poll's `isDone` arrow reads the
	// live value instead of capturing false forever.
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

	// The pool never rejects (it folds task errors into freed slots) and its
	// `.finally` always flips tasksDone, so pollPromise terminates within
	// ~pollMs — neither promise orphans the other.
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

	// Forward in arrival order so the streaming-progress lines stay
	// deterministic, then fire deletes in parallel — when several packages
	// land between two poll ticks, serial deletes can stack up to a full
	// poll interval of latency before the next read sees fresh entries.
	for (const record of records) {
		hooks.onPackageResult(record.value);
	}

	await Promise.all(
		records.map(async (record) => {
			try {
				await hooks.reader.deleteAsync(record.id);
			} catch (err) {
				// Best-effort; if delete fails the entry will reappear on the
				// next poll and onPackageResult dedupes downstream. Still surface
				// the first failure so users know their key can read but not
				// write.
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

/**
 * Poll the streaming SortedMap until `isDone()` returns true, then perform
 * one final drain. Each newly-observed entry is forwarded to
 * `onPackageResult` and deleted from the map. Errors are swallowed so a
 * transient HTTP failure doesn't take down the test run — the final task
 * envelope still carries authoritative results.
 *
 * @param hooks - Streaming reader and result callback.
 * @param isDone - Reports when the task wave has settled.
 */
async function pollStreamingResultsAsync(
	hooks: StreamingHooks,
	isDone: () => boolean,
): Promise<void> {
	const pollMs = hooks.pollMs ?? DEFAULT_STREAM_POLL_MS;
	const state: PollState = { warned: false };

	while (!isDone()) {
		await drainOnceAsync(hooks, state);
		await sleepAsync(pollMs);
	}

	// Final pass to catch any entries written between the last drain and
	// tasksDone.
	await drainOnceAsync(hooks, state);
}

/**
 * Drive the work-stealing task set through the shared roblox-runner pool.
 *
 * A worker normally drains the queue until it is empty, so `taskCount` tasks
 * cover the known set and no slot ever needs refilling — the wave is exactly
 * `taskCount` tasks, as it was before deferral existed.
 *
 * The exception is a worker that fills its return-envelope budget: Open Cloud
 * rejects a task returning more than 4 MiB, so the worker stops early, leaves
 * the rest of the queue behind and says so (`deferred`). Each deferral earns
 * exactly one replacement launch, which may itself defer, chaining until the
 * queue drains.
 *
 * `maxLaunches` bounds that chain: a worker always takes at least one item, so
 * covering `jobCount` jobs can never need more than `jobCount` extra tasks.
 *
 * @param options - Task runner, task and job counts, and the outcome to fill.
 */
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
			// The pool folds a task failure into a freed slot and resolves, so
			// without this the failure would be masked whenever a sibling task
			// drains the whole queue and covers every package. Capture it and
			// rethrow once the pool settles so an infrastructure or script
			// failure always fails the run, as the old `Promise.all` wave did.
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
					// Claim the deferral this launch answers, so two launches
					// never settle the same one.
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
