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
const LOCKOUT_REFUSAL =
	"Task creation failed: status=429; retry-after=1856; x-envoy-ratelimited=<absent>; " +
	"x-ratelimit-remaining=<absent>; x-ratelimit-reset=<absent>; " +
	"x-roblox-system-reason=<absent>; x-retry-after-coverage=<absent>; " +
	'body={"code":"RESOURCE_EXHAUSTED","message":"dmaas"}';

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

	it("should skip on a raw 429 that outlasts the minute window", async () => {
		expect.assertions(1);

		const { context, skip } = fakeContext();
		await skipOnQuotaAsync(context, Promise.reject(new Error(LOCKOUT_REFUSAL))).catch(() => {});

		expect(skip).toHaveBeenCalledWith(
			true,
			"open-cloud-quota: Roblox refused the task create beyond its per-minute limit",
		);
	});

	it.for([
		["the per-key minute limit", LOCKOUT_REFUSAL.replace("1856", "42")],
		[
			"a 429 without a retry-after",
			LOCKOUT_REFUSAL.replace("retry-after=1856", "retry-after=<absent>"),
		],
		[
			"a 429 that is not RESOURCE_EXHAUSTED",
			LOCKOUT_REFUSAL.replace("RESOURCE_EXHAUSTED", "OTHER"),
		],
		["another status", LOCKOUT_REFUSAL.replace("status=429", "status=500")],
	])("should rethrow without skipping on %s", async ([, message]) => {
		expect.assertions(2);

		const { context, skip } = fakeContext();

		await expect(skipOnQuotaAsync(context, Promise.reject(new Error(message)))).rejects.toThrow(
			message,
		);
		expect(skip).toHaveBeenCalledWith(false, undefined);
	});
});
