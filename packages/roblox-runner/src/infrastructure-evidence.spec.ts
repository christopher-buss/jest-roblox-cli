import { PollTimeoutError, RateLimitError } from "@bedrock-rbx/ocale";

import { describe, expect, it, vi } from "vitest";

import { makePollContext } from "#test/helpers/unit/poll-context.ts";
import {
	collectQuotaEvidence,
	collectStallEvidence,
	computeUnlockTime,
	redactSecret,
} from "./infrastructure-evidence.ts";

describe("infrastructure evidence", () => {
	it("should redact every occurrence of the secret without changing other text", () => {
		expect.assertions(2);

		expect(redactSecret("key:key:value", "key")).toBe("[REDACTED]:[REDACTED]:value");
		expect(redactSecret("unchanged", "key")).toBe("unchanged");
	});

	it("should record the unlock time, task identity and redacted response fields", () => {
		expect.assertions(2);

		vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
		const error = new RateLimitError("refused", {
			code: "key-code",
			responseHeaders: { diagnostic: "key key" },
			retryAfterSeconds: 75,
		});

		expect(computeUnlockTime(error)).toStrictEqual(new Date("2026-01-01T00:01:15.000Z"));
		expect(
			collectQuotaEvidence(error, { apiKey: "key", placeVersion: 3, timeoutSeconds: 4 }),
		).toStrictEqual({
			code: "[REDACTED]-code",
			headers: { diagnostic: "[REDACTED] [REDACTED]" },
			kind: "create-quota",
			placeVersion: 3,
			retryAfterSeconds: 75,
			timeoutSeconds: 4,
			unlockTime: "2026-01-01T00:01:15.000Z",
		});
	});

	it("should retain missing quota metadata as missing", () => {
		expect.assertions(1);

		vi.spyOn(Date, "now").mockReturnValue(0);

		expect(
			collectQuotaEvidence(new RateLimitError("refused", { retryAfterSeconds: 0 }), {
				apiKey: "key",
				placeVersion: undefined,
				timeoutSeconds: 5,
			}),
		).toStrictEqual({
			code: undefined,
			headers: {},
			kind: "create-quota",
			placeVersion: undefined,
			retryAfterSeconds: 0,
			timeoutSeconds: 5,
			unlockTime: "1970-01-01T00:00:00.000Z",
		});
	});

	it("should capture the server's timestamps and a changed observed state", () => {
		expect.assertions(1);

		const error = new PollTimeoutError("timeout", {
			lastObservedTask: {
				createdAt: new Date(0),
				state: "QUEUED",
				updatedAt: new Date(1000),
			},
			timeoutMs: 1,
		});

		expect(collectStallEvidence(makePollContext(), error)).toStrictEqual({
			createTime: "1970-01-01T00:00:00.000Z",
			kind: "task-stall",
			observedStates: ["PROCESSING", "QUEUED"],
			placeVersion: 7,
			task: "universes/1/places/2/versions/7/luau-execution-sessions/session/tasks/task",
			timeoutSeconds: 1,
			updateTime: "1970-01-01T00:00:01.000Z",
		});
	});

	it.for([undefined, null, { state: "PROCESSING" }, { createdAt: "not a Date", state: 3 }])(
		"should preserve the submitted state when observation adds no state: %j",
		(lastObservedTask) => {
			expect.assertions(1);

			expect(
				collectStallEvidence(
					makePollContext(),
					new PollTimeoutError("timeout", { lastObservedTask, timeoutMs: 1 }),
				),
			).toMatchObject({
				createTime: undefined,
				observedStates: ["PROCESSING"],
				updateTime: undefined,
			});
		},
	);
});
