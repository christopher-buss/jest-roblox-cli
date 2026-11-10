import { RateLimitError } from "@bedrock-rbx/ocale";
import { TaskQuotaError } from "@isentinel/roblox-runner";
import { fromPartial } from "@total-typescript/shoehorn";

import type { TestContext } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { quotaSkipNote, skipOnQuotaAsync } from "./quota-skip.ts";

const QUOTA_STDERR = [
	"RESOURCE_EXHAUSTED: Luau task creation rate limit exceeded.",
	"  Evidence:",
	"    kind: create-quota",
	"    unlockTime: 2026-10-04T13:20:10.627Z",
].join("\n");
function fakeContext() {
	const skip = vi.fn<(condition: boolean, note?: string) => void>();
	return { context: fromPartial<TestContext>({ skip }), skip };
}

describe(quotaSkipNote, () => {
	it("should name the unlock time of a quota-refused run", () => {
		expect.assertions(1);

		expect(quotaSkipNote({ exitCode: 3, stderr: QUOTA_STDERR, stdout: "" })).toBe(
			"open-cloud-quota: Roblox refused the task create until 2026-10-04T13:20:10.627Z",
		);
	});

	it("should ignore a stalled task, which is also exit 3", () => {
		expect.assertions(1);

		expect(
			quotaSkipNote({ exitCode: 3, stderr: "    kind: task-stall", stdout: "" }),
		).toBeUndefined();
	});

	it("should ignore a failed run that mentions the quota", () => {
		expect.assertions(1);

		expect(quotaSkipNote({ exitCode: 1, stderr: QUOTA_STDERR, stdout: "" })).toBeUndefined();
	});

	it("should fall back to an unknown unlock time", () => {
		expect.assertions(1);

		expect(quotaSkipNote({ exitCode: 3, stderr: "    kind: create-quota", stdout: "" })).toBe(
			"open-cloud-quota: Roblox refused the task create until an unknown time",
		);
	});
});

describe(skipOnQuotaAsync, () => {
	it("should return the value of a call that succeeds", async () => {
		expect.assertions(1);

		const { context } = fakeContext();

		await expect(skipOnQuotaAsync(context, Promise.resolve("done"))).resolves.toBe("done");
	});

	it("should skip on a quota refusal from the runner", async () => {
		expect.assertions(2);

		const { context, skip } = fakeContext();
		const refused = new TaskQuotaError({
			cause: new RateLimitError("Rate limited", { retryAfterSeconds: 1856, statusCode: 429 }),
			evidence: {
				code: "RESOURCE_EXHAUSTED",
				headers: {},
				kind: "create-quota",
				placeVersion: 42,
				retryAfterSeconds: 1856,
				timeoutSeconds: 300,
				unlockTime: "2026-10-04T13:20:10.627Z",
			},
			message: "RESOURCE_EXHAUSTED",
		});

		await expect(skipOnQuotaAsync(context, Promise.reject(refused))).rejects.toBe(refused);
		expect(skip).toHaveBeenCalledWith(
			true,
			"open-cloud-quota: Roblox refused the task create until 2026-10-04T13:20:10.627Z",
		);
	});

	it("should rethrow without skipping on any other failure", async () => {
		expect.assertions(2);

		const { context, skip } = fakeContext();
		const failure = new Error("Roblox task failed (SCRIPT_ERROR): boom");

		await expect(skipOnQuotaAsync(context, Promise.reject(failure))).rejects.toBe(failure);
		expect(skip).toHaveBeenCalledWith(false, undefined);
	});
});
