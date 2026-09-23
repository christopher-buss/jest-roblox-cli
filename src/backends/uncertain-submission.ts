import { NetworkError, TRANSIENT_TRANSPORT_CODES } from "@bedrock-rbx/ocale";
import { ExecutionTimeoutError, TaskSubmitError } from "@isentinel/roblox-runner";

import { walkErrorChain } from "../utils/error-chain.ts";

const transientCodes = new Set<string | undefined>(TRANSIENT_TRANSPORT_CODES);
const transientStatuses = new Set([500, 502, 503, 504]);

/**
 * The create may have succeeded; its relay remains observable without a task
 * ref.
 */
export class UncertainSubmissionError extends ExecutionTimeoutError {}

export function isUncertainTaskSubmit(error: unknown): error is TaskSubmitError {
	return (
		error instanceof TaskSubmitError &&
		(isRequestTimeout(error.cause) ||
			walkErrorChain(error).some((entry) => {
				return (
					(entry.statusCode !== undefined && transientStatuses.has(entry.statusCode)) ||
					transientCodes.has(entry.code)
				);
			}))
	);
}

function isRequestTimeout(error: Error): boolean {
	return (
		error instanceof NetworkError &&
		error.cause instanceof DOMException &&
		error.cause.name === "TimeoutError"
	);
}
