import type { ScriptResult } from "./types.ts";

export interface TaskPoolOptions {
	/** Number of task-slots to keep full (single place: capped at 10). */
	concurrency: number;
	/**
	 * True once every enqueued unit has a terminal result. The pool stops
	 * launching new tasks once this returns true and resolves after the
	 * in-flight tasks settle. Owned by the consumer (e.g. the mutation runner
	 * tracks which global indices have a verdict).
	 */
	isDone: () => boolean;
	/** Observe a task that threw (timeout, transient API error). */
	onError?: (error: unknown) => void;
	/** Fold a settled task's envelope into the consumer's result set. */
	onResult: (result: ScriptResult) => void;
	/** Launch one task; resolves with the task's return envelope. */
	runTask: () => Promise<ScriptResult>;
}

/**
 * Drive a replenishing pool of long-lived tasks against a single place: keep
 * `concurrency` slots full, relaunch a slot when a task returns while work
 * remains (`!isDone()`), and resolve once every slot has drained and the
 * done-signal has fired. The pool is jest/mutation-agnostic — chunk sizing,
 * result de-duplication, and bail live in the consumer. A task that throws frees its
 * slot (its in-flight work re-surfaces via the queue invisibility window) and
 * is relaunched while work remains, so a transient failure neither aborts the
 * run nor corrupts results.
 */
export async function runTaskPool(options: TaskPoolOptions): Promise<void> {
	const { concurrency, isDone, onError, onResult, runTask } = options;

	if (concurrency < 1) {
		throw new Error(`runTaskPool concurrency must be >= 1, got ${String(concurrency)}`);
	}

	await new Promise<void>((resolve) => {
		let inFlight = 0;

		async function settleTask(): Promise<void> {
			try {
				onResult(await runTask());
			} catch (err) {
				onError?.(err);
			} finally {
				inFlight -= 1;
				pump();
			}
		}

		function pump(): void {
			while (inFlight < concurrency && !isDone()) {
				inFlight += 1;
				void settleTask();
			}

			if (inFlight === 0) {
				resolve();
			}
		}

		pump();
	});
}
