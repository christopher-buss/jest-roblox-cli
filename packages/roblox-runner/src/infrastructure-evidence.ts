import type { PollTimeoutError, RateLimitError } from "@bedrock-rbx/ocale";

import type { PollContext } from "./poll-diagnosis.ts";
import { describeTaskRef, readTaskField } from "./poll-diagnosis.ts";
import type { RunnerCredentials } from "./runner-types.ts";

/**
 * What Roblox needs to look up a task that never reached a terminal state.
 * Timestamps are Roblox's own, so a report can be matched to its server logs.
 */
export interface TaskStallEvidence {
	/**
	 * Server creation timestamp, absent when no observation supplies it.
	 */
	readonly createTime: string | undefined;
	/**
	 * Discriminates quota refusal from an inconclusive task stall.
	 */
	readonly kind: "task-stall";
	/**
	 * The state the submit answered with, then the last polled one if it
	 * differs.
	 */
	readonly observedStates: ReadonlyArray<string>;
	/**
	 * Pinned place version; absent when submitting against head.
	 */
	readonly placeVersion: number | undefined;
	/** The task's resource path. */
	readonly task: string;
	/**
	 * Server execution deadline in seconds, independent of place boot time.
	 */
	readonly timeoutSeconds: number;
	/**
	 * Server update timestamp, absent when no observation supplies it.
	 */
	readonly updateTime: string | undefined;
}

/** What Roblox needs to look up a task create its quota refused. */
export interface CreateQuotaEvidence {
	/**
	 * Server diagnostic code after secret redaction.
	 */
	readonly code: string | undefined;
	/** The rate-limit and diagnostic response headers ocale kept. */
	readonly headers: Readonly<Record<string, string>>;
	/**
	 * Discriminates quota refusal from an inconclusive task stall.
	 */
	readonly kind: "create-quota";
	/**
	 * Pinned place version; absent when submitting against head.
	 */
	readonly placeVersion: number | undefined;
	/**
	 * Server retry hint in seconds, retained without rounding.
	 */
	readonly retryAfterSeconds: number;
	/**
	 * Server execution deadline in seconds, independent of place boot time.
	 */
	readonly timeoutSeconds: number;
	/** When `retry-after` says the quota lets the create through again. */
	readonly unlockTime: string;
}

/**
 * Diagnostic evidence distinguishes a refused create from an unanswered task.
 */
export type InfrastructureEvidence = CreateQuotaEvidence | TaskStallEvidence;

/** The task a refused create described, and the secret it was sent with. */
export interface RefusedCreate extends Pick<RunnerCredentials, "apiKey"> {
	/**
	 * Pinned place version; absent when submitting against head.
	 */
	readonly placeVersion: number | undefined;
	/**
	 * Server execution deadline in seconds, independent of place boot time.
	 */
	readonly timeoutSeconds: number;
}

/**
 * The instant a 429's `retry-after` names.
 * @param err - Failure returned by the transport.
 * @returns Time at which the retry-after delay elapses.
 */
export function computeUnlockTime(err: RateLimitError): Date {
	return new Date(Date.now() + err.retryAfterSeconds * 1000);
}

const REDACTED = "[REDACTED]";

/**
 * Evidence goes into bug reports, so the API key never survives into it.
 * @param text - Diagnostic text that may contain the API key.
 * @param secret - Exact API key to redact.
 * @returns Diagnostic text with every occurrence of the API key removed.
 */
export function redactSecret(text: string, secret: string): string {
	return text.split(secret).join(REDACTED);
}

/**
 * Capture the refusal while removing the API key from diagnostics.
 * @param err - Failure returned by the transport.
 * @param task - Refused create, carrying the API key and place version.
 * @returns Redacted quota refusal evidence for the submitted place version.
 */
export function collectQuotaEvidence(
	err: RateLimitError,
	task: RefusedCreate,
): CreateQuotaEvidence {
	const headers = Object.entries(err.responseHeaders ?? {}).map(([name, value]) => {
		return [name, redactSecret(value, task.apiKey)] as const;
	});
	return {
		code: err.code === undefined ? undefined : redactSecret(err.code, task.apiKey),
		headers: Object.fromEntries(headers),
		kind: "create-quota",
		placeVersion: task.placeVersion,
		retryAfterSeconds: err.retryAfterSeconds,
		timeoutSeconds: task.timeoutSeconds,
		unlockTime: computeUnlockTime(err).toISOString(),
	};
}

/**
 * Record observations without claiming that execution started.
 * @param context - Original task identity and observation budgets.
 * @param error - Poll timeout whose last observed task is read.
 * @returns Inconclusive task observations with no claim about execution startup.
 */
export function collectStallEvidence(
	context: PollContext,
	error: PollTimeoutError,
): TaskStallEvidence {
	const lastObserved: unknown = error.lastObservedTask;
	const lastState = readTaskField(lastObserved, "state");
	return {
		createTime: readTime(lastObserved, "createdAt"),
		kind: "task-stall",
		observedStates:
			typeof lastState === "string" && lastState !== context.submittedState
				? [context.submittedState, lastState]
				: [context.submittedState],
		placeVersion: context.placeVersion,
		task: describeTaskRef(context.ref),
		timeoutSeconds: context.timeoutSeconds,
		updateTime: readTime(lastObserved, "updatedAt"),
	};
}

function readTime(task: unknown, key: "createdAt" | "updatedAt"): string | undefined {
	const value = readTaskField(task, key);
	return value instanceof Date ? value.toISOString() : undefined;
}
