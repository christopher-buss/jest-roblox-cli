import type { OpenCloudError } from "@bedrock-rbx/ocale";

/**
 * A task-create failure, distinguished from failures while observing a task.
 */
export class TaskSubmitError extends Error {
	public override readonly cause: OpenCloudError;

	public override name = "TaskSubmitError";

	constructor(cause: OpenCloudError, message?: string) {
		super(message ?? cause.message, { cause });
		this.cause = cause;
	}
}
