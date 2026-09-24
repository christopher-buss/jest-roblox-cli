import type { OpenCloudError } from "@bedrock-rbx/ocale";

import type { CreateQuotaEvidence } from "./infrastructure-evidence.ts";
import { TaskSubmitError } from "./task-submit-error.ts";

/**
 * A task create the quota refused with a 429: a Roblox infrastructure failure,
 * not a Jest result.
 */
export class TaskQuotaError extends TaskSubmitError {
	public readonly evidence: CreateQuotaEvidence;

	public override name = "TaskQuotaError";

	constructor({
		cause,
		evidence,
		message,
	}: {
		cause: OpenCloudError;
		evidence: CreateQuotaEvidence;
		message: string;
	}) {
		super(cause, message);
		this.evidence = evidence;
	}
}
