import type { OpenCloudError } from "@bedrock-rbx/ocale";
import { PollTimeoutError } from "@bedrock-rbx/ocale";
import type { LuauExecutionTaskRef } from "@bedrock-rbx/ocale/luau-execution";

/**
 * What a poll was given, and where that came from. The default budget is the
 * task deadline plus a boot-lag allowance, and saying so is what stops a
 * timeout reading as "your script was too slow"; an explicit
 * {@link ExecuteScriptOptions.pollBudget} has no such story to tell.
 */
export interface PollContext {
	readonly bootProven: boolean;
	readonly hasDefaultBudget: boolean;
	readonly ref: LuauExecutionTaskRef;
	readonly timeoutSeconds: number;
}

/**
 * Wall clock the poll keeps beyond the server's own task deadline, so the
 * terminal `FAILED` the server writes is observable rather than raced.
 *
 * Roblox starts a task's `timeout` when the script begins running, not when
 * the task is created — a submit answers immediately and the place boot sits
 * between the two. Measured against a warm server the gap is 4-7s; a version
 * nobody has booted yet costs a cold boot, which
 * `open-cloud.ts` documents at 10-45s. A poll budget equal to the deadline
 * therefore expires while the task is still `PROCESSING`, every time, and the
 * authoritative `DEADLINE_EXCEEDED` (or the `SCRIPT_ERROR` the Luau VM writes
 * when it kills a non-yielding loop) is never read: the run reports
 * `PollTimeoutError` for a failure Roblox described.
 *
 * This is a cap, not a wait. A task that fails on time ends the poll the
 * moment it turns terminal, so the grace costs nothing on any run that gets
 * an answer — only a task Roblox never resolves spends it.
 */
export const TASK_DEADLINE_GRACE_MS = 45_000;

/**
 * The task's resource path, which is what the Open Cloud API and the Creator
 * Dashboard both key on. Built from the ref rather than kept as the raw
 * server string because ocale parses the path away on the way in.
 *
 * @param ref - The task reference carried on every task and every submit.
 * @returns The `universes/…/tasks/…` path, omitting segments Roblox left out.
 */
export function describeTaskRef(ref: LuauExecutionTaskRef): string {
	// Both optional segments are present on any ref that got this far: ocale's
	// GET builder rejects a ref missing either, so a task that was polled at all
	// carries them — including one submitted against head, which Roblox answers
	// with the version it resolved.
	return (
		`universes/${ref.universeId}/places/${ref.placeId}` +
		`/versions/${String(ref.versionId)}` +
		`/luau-execution-sessions/${String(ref.sessionId)}/tasks/${ref.taskId}`
	);
}

/**
 * Expands a poll that never settled into something actionable. Reaching here
 * is itself the diagnosis, and {@link describeSuspects} says what it means.
 *
 * Everything else is passed through: an API response is already specific.
 *
 * @param err - The error the poll settled on.
 * @param context - The task polled and the deadline it was submitted with.
 * @returns The error to throw, carrying the ocale error as its cause.
 */
export function toPollError(err: OpenCloudError, context: PollContext): Error {
	if (!(err instanceof PollTimeoutError)) {
		return new Error(err.message, { cause: err });
	}

	const lines = [
		"Execution timed out: Roblox never reported a terminal state for the task " +
			`within ${String(Math.round(err.timeoutMs / 1000))}s${describeBudgetOrigin(context)}.`,
		`  task: ${describeTaskRef(context.ref)}`,
		`  last observed state: ${readObservedState(err.lastObservedTask)}`,
		...describeSuspects(context),
	];
	return new Error(lines.join("\n"), { cause: err });
}

/** How the poll budget was arrived at, or nothing when the caller named it. */
function describeBudgetOrigin(context: PollContext): string {
	if (!context.hasDefaultBudget) {
		return "";
	}

	return (
		` (${String(context.timeoutSeconds)}s task deadline plus a ` +
		`${String(Math.round(TASK_DEADLINE_GRACE_MS / 1000))}s boot-lag allowance)`
	);
}

/**
 * What is left to suspect once the poll has run out.
 *
 * Roblox fails a task that merely outran its deadline — `DEADLINE_EXCEEDED`
 * lands a boot lag after the deadline elapsed, which is what
 * {@link TASK_DEADLINE_GRACE_MS} waits for. A task still running past both has
 * not overrun; it was never scheduled, and the usual reason is a place version
 * Roblox cannot load. Measured against one, the task sat `PROCESSING` for ten
 * minutes on a 30s deadline and Roblox reported no state, no error, and no
 * logs, ever.
 *
 * A caller that proved the boot has ruled that out already, and repeating the
 * guess would send the reader to Studio to inspect a place that loads.
 *
 * @param context - The task polled and what the caller knows about its place.
 * @returns Lines naming the suspects, indented to sit under the first.
 */
function describeSuspects(context: PollContext): Array<string> {
	if (context.bootProven) {
		return [
			"  This place version is known to boot — a script ran against it just " +
				"before this task was submitted — so a place Roblox cannot load " +
				"is ruled out.",
			"  What is left is a task Open Cloud never scheduled: retry, and if " +
				"it repeats, the fault is outside this run.",
		];
	}

	return [
		"  A script that merely outran its deadline is failed by Roblox, so this " +
			"is most likely a place version Roblox could not start — such a task " +
			"is never scheduled and never reports anything. Open the place file " +
			"in Studio to see why it will not load.",
		"  The other reading is an unusually slow cold boot, which the next run " +
			"avoids by reusing the now-warm server.",
	];
}

/**
 * The state the last polled task was in, or `"unknown"`.
 *
 * `lastObservedTask` is `unknown` on the error type ocale hands back, and it is
 * absent entirely when the budget ran out before a single poll answered.
 * `Object()` flattens both into something readable, so one fallback covers a
 * missing task and an unrecognised one alike.
 *
 * @param task - The task the timeout error carried, if any.
 * @returns The task's state, or `"unknown"` when there is none to read.
 */
function readObservedState(task: unknown): string {
	const state: unknown = Reflect.get(Object(task), "state");
	return typeof state === "string" ? state : "unknown";
}
