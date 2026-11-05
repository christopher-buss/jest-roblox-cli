import { NetworkError, TRANSIENT_TRANSPORT_CODES } from "@bedrock-rbx/ocale";
import { TaskSubmitError } from "@isentinel/roblox-runner";

import { walkErrorChain } from "../utils/error-chain.ts";

const transientCodes = new Set<string | undefined>(TRANSIENT_TRANSPORT_CODES);
const transientStatuses = new Set([500, 502, 503, 504]);

/**
 * Whether a failed task submit may still have created the task.
 *
 * @param error - Error a task submit threw.
 * @returns True for a request timeout or a transient status or transport code.
 */
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
