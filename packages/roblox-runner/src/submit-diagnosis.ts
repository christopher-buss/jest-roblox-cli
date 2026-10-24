import {
	RateLimitError,
	RateLimitWaitRefusedError,
	RetryDelayExceededError,
} from "@bedrock-rbx/ocale";
import type { OpenCloudError } from "@bedrock-rbx/ocale";
import type { LuauExecutionClient } from "@bedrock-rbx/ocale/luau-execution";

import { type } from "arktype";

import type { RefusedCreate } from "./infrastructure-evidence.ts";
import {
	collectQuotaEvidence,
	computeUnlockTime,
	redactSecret,
} from "./infrastructure-evidence.ts";
import { TaskQuotaError } from "./task-quota-error.ts";
import { TaskSubmitError } from "./task-submit-error.ts";

const MINUTE_WINDOW_SECONDS = 60;
const ISO_MILLISECONDS = /\.\d{3}Z$/u;
const edgeRateLimitSchema = type({ errors: "unknown[]" });
function isEdgeRefusal(err: RateLimitError): boolean {
	return !(edgeRateLimitSchema(err.details) instanceof type.errors);
}

const serverErrorSchema = type({ code: "string", message: "string" });

type SubmitResult = Awaited<ReturnType<LuauExecutionClient["tasks"]["submit"]>>;

/**
 * Names a submit that never created a task. Kept apart from the poll path
 * because a submit failure has no task to point at — there is nothing to look
 * up and nothing to log. A 429 is the quota's refusal, and carries its
 * evidence.
 *
 * @param err - The error the submit returned.
 * @param task - The refused task, and the API key its evidence must not carry.
 * @returns The error to throw, carrying the ocale error as its cause.
 */
export function toSubmitError(err: OpenCloudError, task: RefusedCreate): Error {
	if (
		(err instanceof RetryDelayExceededError || err instanceof RateLimitWaitRefusedError) &&
		err.cause instanceof RateLimitError
	) {
		return toQuotaError({ err, headline: err.message, rateLimit: err.cause, task });
	}

	if (!(err instanceof RateLimitError)) {
		return new TaskSubmitError(err);
	}

	const details = serverErrorSchema(err.details);
	const headline =
		details instanceof type.errors ? err.message : `${details.code}: ${details.message}`;
	return toQuotaError({ err, headline, rateLimit: err, task });
}

/**
 * A 429 from the edge rate limit, which never reached dmaas: only the edge
 * answers with a bare `errors` list.
 * @param result - SDK submission success or refusal.
 * @returns Whether this is a retryable edge refusal rather than a service verdict.
 */
export function isEdgeRateLimited(
	result: SubmitResult,
): result is Extract<SubmitResult, { success: false }> & { err: RateLimitError } {
	return !result.success && result.err instanceof RateLimitError && isEdgeRefusal(result.err);
}

/**
 * Refuse a retry wait that would end past the task deadline, naming the wait
 * and what is left of the deadline.
 * @param options - Original refusal, absolute deadline and proposed wait duration.
 * @returns Deadline failure when the wait cannot fit, otherwise undefined.
 */
export function refuseUnfitWait({
	cause,
	deadlineMs,
	waitMs,
}: {
	cause: OpenCloudError;
	deadlineMs: number;
	waitMs: number;
}): RetryDelayExceededError | undefined {
	const remainingMs = Math.max(0, deadlineMs - Date.now());
	if (waitMs <= remainingMs) {
		return undefined;
	}

	return new RetryDelayExceededError(
		"Open Cloud asked the task create to wait before retrying, past the task deadline: " +
			`would wait ${String(Math.round(waitMs / 1000))}s; ${String(Math.round(remainingMs / 1000))}s remain`,
		{ cause, deadlineMs, remainingMs, retryAfterMs: waitMs },
	);
}

/**
 * The unlock of an account lockout, when the 429 is one: a dmaas refusal whose
 * wait outlasts the per-minute window.
 * @param err - Failure returned by the transport.
 * @returns Account unlock timing when the refusal supplies it.
 */
function describeLockoutUnlock(err: RateLimitError): Array<string> {
	if (isEdgeRefusal(err) || err.retryAfterSeconds <= MINUTE_WINDOW_SECONDS) {
		return [];
	}

	const unlock = computeUnlockTime(err);
	return [
		"  Roblox refused task creates for longer than its per-minute limit; " +
			`this account can create tasks again at ${unlock.toISOString().replace(ISO_MILLISECONDS, "Z")}.`,
	];
}

/**
 * The 429's evidence, one line each: the lockout unlock, code and headers.
 * @param err - Failure returned by the transport.
 * @returns Quota refusal details including retry hints and server evidence.
 */
function describeRateLimit(err: RateLimitError): Array<string> {
	return [
		...describeLockoutUnlock(err),
		...(err.code === undefined ? [] : [`  code: ${err.code}`]),
		...Object.entries(err.responseHeaders ?? {}).map(([name, value]) => `  ${name}: ${value}`),
	];
}

function toQuotaError({
	err,
	headline,
	rateLimit,
	task,
}: {
	err: OpenCloudError;
	headline: string;
	rateLimit: RateLimitError;
	task: RefusedCreate;
}): TaskQuotaError {
	const message = [headline, ...describeRateLimit(rateLimit)].join("\n");
	return new TaskQuotaError({
		cause: err,
		evidence: collectQuotaEvidence(rateLimit, task),
		message: redactSecret(message, task.apiKey),
	});
}
