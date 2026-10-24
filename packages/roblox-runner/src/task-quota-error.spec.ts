import { RateLimitError } from "@bedrock-rbx/ocale";

import { describe, expect, it } from "vitest";

import type { CreateQuotaEvidence } from "./infrastructure-evidence.ts";
import { TaskQuotaError } from "./task-quota-error.ts";

describe(TaskQuotaError, () => {
	it("should carry the refused create evidence and original cause", () => {
		expect.assertions(4);

		const cause = new RateLimitError("quota", { remaining: 0, retryAfterSeconds: 70 });
		const evidence = {
			code: undefined,
			headers: {},
			kind: "create-quota",
			placeVersion: 2,
			retryAfterSeconds: 70,
			timeoutSeconds: 5,
			unlockTime: "2026-01-01T00:01:10.000Z",
		} satisfies CreateQuotaEvidence;
		const error = new TaskQuotaError({ cause, evidence, message: "try later" });

		expect(error.name).toBe("TaskQuotaError");
		expect(error.message).toBe("try later");
		expect(error.cause).toBe(cause);
		expect(error.evidence).toBe(evidence);
	});
});
