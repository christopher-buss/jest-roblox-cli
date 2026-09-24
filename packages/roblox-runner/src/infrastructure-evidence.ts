import type { PollTimeoutError, RateLimitError } from "@bedrock-rbx/ocale";

import type { PollContext } from "./poll-diagnosis.ts";
import { describeTaskRef, readTaskField } from "./poll-diagnosis.ts";

/**
 * What Roblox needs to look up a task that never reached a terminal state.
 * Timestamps are Roblox's own, so a report can be matched to its server logs.
 */
export interface TaskStallEvidence {
	readonly createTime: string | undefined;
	readonly kind: "task-stall";
	/**
	 * The state the submit answered with, then the last polled one if it
	 * differs.
	 */
	readonly observedStates: ReadonlyArray<string>;
	readonly placeVersion: number | undefined;
	/** The task's resource path. */
	readonly task: string;
	readonly timeoutSeconds: number;
	readonly updateTime: string | undefined;
}

/** What Roblox needs to look up a task create its quota refused. */
export interface CreateQuotaEvidence {
	readonly code: string | undefined;
	/** The rate-limit and diagnostic response headers ocale kept. */
	readonly headers: Readonly<Record<string, string>>;
	readonly kind: "create-quota";
	readonly placeVersion: number | undefined;
	readonly retryAfterSeconds: number;
	readonly timeoutSeconds: number;
	/** When `retry-after` says the quota lets the create through again. */
	readonly unlockTime: string;
}

export type InfrastructureEvidence = CreateQuotaEvidence | TaskStallEvidence;

/** The task a refused create described, and the secret it was sent with. */
export interface RefusedCreate {
	readonly apiKey: string;
	readonly placeVersion: number | undefined;
	readonly timeoutSeconds: number;
}

/** The instant a 429's `retry-after` names. */
export function computeUnlockTime(err: RateLimitError): Date {
	return new Date(Date.now() + err.retryAfterSeconds * 1000);
}

const REDACTED = "[REDACTED]";

/** Evidence goes into bug reports, so the API key never survives into it. */
export function redactSecret(text: string, secret: string): string {
	return text.split(secret).join(REDACTED);
}

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
