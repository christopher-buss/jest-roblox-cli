import { TaskQuotaError, TaskStallError } from "@isentinel/roblox-runner";

/** The exit code of a run its infrastructure failed. */
export const INFRASTRUCTURE_EXIT_CODE = 3;

/** An error that means Roblox infrastructure, not the tests, failed the run. */
export type InfrastructureFailure = MissingGapRecordError | TaskQuotaError | TaskStallError;

/** A run whose gap record does not cover its results. */
export class MissingGapRecordError extends Error {}

/**
 * Whether a thrown value is an infrastructure failure.
 * @param err - The thrown value.
 * @returns True for a task stall, task quota or missing gap record error.
 */
export function isInfrastructureFailure(err: unknown): err is InfrastructureFailure {
	return (
		err instanceof TaskStallError ||
		err instanceof TaskQuotaError ||
		err instanceof MissingGapRecordError
	);
}
