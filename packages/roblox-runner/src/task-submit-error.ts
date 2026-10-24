import type { OpenCloudError } from "@bedrock-rbx/ocale";

/**
 * A task-create failure, distinguished from failures while observing a task.
 */
export class TaskSubmitError extends Error {
	public override readonly cause: OpenCloudError;

	public override name = "TaskSubmitError";

	/**
	 * Retain a submission failure and its original cause.
	 * @param cause - Original transport failure.
	 * @param message - Specific diagnostic text, otherwise the original message.
	 */
	constructor(cause: OpenCloudError, message?: string) {
		super(message ?? cause.message);
		this.cause = cause;
	}
}
