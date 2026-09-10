import type { OpenCloudError } from "@bedrock-rbx/ocale";
import { ApiError, NetworkError, PollTimeoutError } from "@bedrock-rbx/ocale";
import type { FailedTask, LuauExecutionTaskRef } from "@bedrock-rbx/ocale/luau-execution";

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
/**
 * Task log messages carried on a failure, counted from the end. The tail is
 * what explains the failure; a full Jest run's output is megabytes and the
 * error banner is not where anyone reads it.
 */
export const FAILURE_LOG_TAIL = 20;

/** Per-message cap on the failure log tail, in characters. */
const FAILURE_LOG_MESSAGE_LIMIT = 400;

const TASK_DEADLINE_GRACE_MS = 45_000;

const MAX_TASK_TIMEOUT_SECONDS = 300;

/** The default poll budget outlasts the task deadline and place startup. */
export function resolveBudgets(
	timeout: number,
	pollBudget: number | undefined,
): { hasDefaultBudget: boolean; pollBudgetMs: number; timeoutSeconds: number } {
	const timeoutSeconds = Math.min(Math.floor(timeout / 1000), MAX_TASK_TIMEOUT_SECONDS);
	return {
		hasDefaultBudget: pollBudget === undefined,
		pollBudgetMs:
			pollBudget ?? Math.max(timeout, timeoutSeconds * 1000 + TASK_DEADLINE_GRACE_MS),
		timeoutSeconds,
	};
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

/**
 * The HTTP status a refusal carried, as a parenthetical, or nothing when the
 * call never reached a response.
 *
 * The status is what separates the causes a caller can act on: a 429 is the
 * per-key create quota and worth a retry, a 401 is the key itself, and a
 * transport failure has no status at all. Written like the PUT's own message
 * so the two halves of one upload read the same way.
 */
export function describeStatus(err: OpenCloudError): string {
	return err instanceof ApiError ? ` (HTTP ${String(err.statusCode)})` : "";
}

/**
 * Expands an upload failure into one diagnostic line. An `ApiError` carries
 * the failing call and how long it was in flight, and a bare `err.message`
 * throws all of that away: `HTTP 502: Request Context Failure` alone says
 * nothing about which request died, or whether it died on the wire or after
 * 30 seconds of upload.
 *
 * @param err - The Open Cloud error the upload returned.
 * @returns The error message, followed by the request context ocale captured.
 */
export function describeUploadFailure(err: OpenCloudError): string {
	if (!(err instanceof ApiError) && !(err instanceof NetworkError)) {
		return err.message;
	}

	const target = err.url === undefined ? "" : ` on ${err.method} ${err.url}`;
	const elapsed =
		err instanceof ApiError && err.elapsedMs !== undefined
			? ` after ${(err.elapsedMs / 1000).toFixed(1)}s`
			: "";
	return `${err.message}${target}${elapsed}`;
}

/**
 * One log line, prefixed by the severity Roblox assigned it so an `ERROR`
 * stands out from the `print` above it, and truncated so one runaway line
 * cannot push the rest of the tail off the banner.
 *
 * @param message - A structured log message from the task's log page.
 * @returns The formatted, length-capped line.
 */
export function formatLogMessage({
	message,
	messageType,
}: {
	message: string;
	messageType: string;
}): string {
	const body =
		message.length > FAILURE_LOG_MESSAGE_LIMIT
			? `${message.slice(0, FAILURE_LOG_MESSAGE_LIMIT)}…`
			: message;
	return `[${messageType}] ${body}`;
}

/**
 * Names a terminal Roblox failure in full: the category code, Roblox's own
 * message, the task the run can be looked up by, and what the script printed
 * before it died.
 *
 * The code is not decoration. `DEADLINE_EXCEEDED` means the script outran its
 * budget and the log tail is where it was stuck; `SCRIPT_ERROR` means it threw
 * and the tail holds the traceback. Reporting `error.message` alone loses that
 * split, and loses the task id entirely.
 *
 * @param task - The `FAILED` task Roblox returned.
 * @param logTail - Formatted log lines, newest last; may be empty.
 * @returns The multi-line failure description.
 */
export function describeTaskFailure(task: FailedTask, logTail: ReadonlyArray<string>): string {
	const lines = [
		`Roblox task failed (${task.error.code}): ${task.error.message}`,
		`  task: ${describeTaskRef(task.ref)}`,
	];
	if (logTail.length > 0) {
		lines.push("  Roblox output before the failure:");
		for (const line of logTail) {
			lines.push(`    ${line}`);
		}
	}

	return lines.join("\n");
}

/**
 * The task's resource path, which is what the Open Cloud API and the Creator
 * Dashboard both key on. Built from the ref rather than kept as the raw
 * server string because ocale parses the path away on the way in.
 *
 * @param ref - The task reference carried on every task and every submit.
 * @returns The `universes/…/tasks/…` path, omitting segments Roblox left out.
 */
function describeTaskRef(ref: LuauExecutionTaskRef): string {
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

/** A poll timeout establishes neither script startup nor place-load failure. */
function describeSuspects(context: PollContext): Array<string> {
	const evidence = context.bootProven
		? "  This place version is known to boot; another task ran against it."
		: "  Place loading, execution, or result delivery may have stalled.";
	return [
		evidence,
		"  PROCESSING does not establish whether the script started or finished. " +
			"A timeout alone cannot authorize running it again; recovery requires an execution claim.",
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
