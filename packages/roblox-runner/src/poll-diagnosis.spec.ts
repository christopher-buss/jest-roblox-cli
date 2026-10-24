import { ApiError, NetworkError, PollTimeoutError, RateLimitError } from "@bedrock-rbx/ocale";
import type { FailedTask } from "@bedrock-rbx/ocale/luau-execution";

import { describe, expect, it } from "vitest";

import { makePollContext } from "#test/helpers/unit/poll-context.ts";
import {
	describeStatus,
	describeTaskFailure,
	describeTaskRef,
	describeUploadFailure,
	FAILURE_LOG_TAIL,
	formatLogMessage,
	readTaskField,
	resolveBudgets,
	toPollError,
} from "./poll-diagnosis.ts";

describe(resolveBudgets, () => {
	it.for([
		{
			expected: {
				hasDefaultBudget: true,
				pollBudgetMs: 46_000,
				recoveryPollBudgetMs: 46_000,
				timeoutSeconds: 1,
			},
			pollBudget: undefined,
			timeout: 1999,
		},
		{
			expected: {
				hasDefaultBudget: false,
				pollBudgetMs: 20,
				recoveryPollBudgetMs: 345_000,
				timeoutSeconds: 300,
			},
			pollBudget: 20,
			timeout: 301_000,
		},
		{
			expected: {
				hasDefaultBudget: false,
				pollBudgetMs: 0,
				recoveryPollBudgetMs: 400_000,
				timeoutSeconds: 300,
			},
			pollBudget: 0,
			timeout: 400_000,
		},
	])(
		"should preserve explicit budgets and cap the server deadline: $timeout",
		({ expected, pollBudget, timeout }) => {
			expect.assertions(1);

			expect(resolveBudgets(timeout, pollBudget)).toStrictEqual(expected);
		},
	);
});

describe("poll diagnostics", () => {
	it("should format the complete resource path and read absent task fields safely", () => {
		expect.assertions(4);

		expect(describeTaskRef(makePollContext().ref)).toBe(
			"universes/1/places/2/versions/7/luau-execution-sessions/session/tasks/task",
		);
		expect(readTaskField({ state: "FAILED" }, "state")).toBe("FAILED");
		expect(readTaskField(undefined, "state")).toBeUndefined();
		expect(FAILURE_LOG_TAIL).toBe(20);
	});

	it("should preserve ordinary poll errors as causes", () => {
		expect.assertions(2);

		const cause = new NetworkError("offline");
		const error = toPollError(cause, makePollContext());

		expect(error.message).toBe("offline");
		expect(error.cause).toBe(cause);
	});

	it("should describe an inconclusive timeout with its default budget and observed state", () => {
		expect.assertions(2);

		const cause = new PollTimeoutError("late", {
			lastObservedTask: { state: "QUEUED" },
			timeoutMs: 46_000,
		});
		const error = toPollError(cause, makePollContext());

		expect(error.cause).toBe(cause);
		expect(error.message).toBe(
			"Execution timed out: Roblox never reported a terminal state for the task within 46s (1s task deadline plus a 45s boot-lag allowance).\n  task: universes/1/places/2/versions/7/luau-execution-sessions/session/tasks/task\n  last observed state: QUEUED\n  Place loading, execution, or result delivery may have stalled.\n  PROCESSING does not establish whether the script started or finished. A timeout alone cannot authorize running it again; recovery requires an execution claim.",
		);
	});

	it("should keep a custom budget and a successful boot probe inconclusive", () => {
		expect.assertions(1);

		expect(
			toPollError(
				new PollTimeoutError("late", { timeoutMs: 1501 }),
				makePollContext({ bootProven: true, hasDefaultBudget: false, pollBudgetMs: 1501 }),
			).message,
		).toBe(
			"Execution timed out: Roblox never reported a terminal state for the task within 2s.\n  task: universes/1/places/2/versions/7/luau-execution-sessions/session/tasks/task\n  last observed state: unknown\n  This place version is known to boot; another task ran against it.\n  PROCESSING does not establish whether the script started or finished. A timeout alone cannot authorize running it again; recovery requires an execution claim.",
		);
	});

	it("should distinguish API statuses from transport errors", () => {
		expect.assertions(2);

		expect(describeStatus(new ApiError("denied", { statusCode: 403 }))).toBe(" (HTTP 403)");
		expect(describeStatus(new NetworkError("offline"))).toBe("");
	});

	it.for([
		{
			error: new ApiError("bad", {
				elapsedMs: 1250,
				method: "POST",
				statusCode: 502,
				url: "https://example.test/place",
			}),
			expected: "bad on POST https://example.test/place after 1.3s",
		},
		{ error: new ApiError("bad", { statusCode: 502 }), expected: "bad" },
		{
			error: new NetworkError("reset", { method: "PUT", url: "https://example.test/place" }),
			expected: "reset on PUT https://example.test/place",
		},
		{ error: new RateLimitError("quota", { retryAfterSeconds: 5 }), expected: "quota" },
	])("should retain upload request context: $expected", ({ error, expected }) => {
		expect.assertions(1);

		expect(describeUploadFailure(error)).toBe(expected);
	});

	it.for([
		{ expected: "x".repeat(399), length: 399 },
		{ expected: "x".repeat(400), length: 400 },
		{ expected: `${"x".repeat(400)}…`, length: 401 },
	])("should cap log messages only past the boundary: %i", ({ expected, length }) => {
		expect.assertions(1);

		expect(formatLogMessage({ message: "x".repeat(length), messageType: "ERROR" })).toBe(
			`[ERROR] ${expected}`,
		);
	});

	it.for([
		{ logTail: [], suffix: "" },
		{
			logTail: ["[ERROR] traceback", "[OUTPUT] tail"],
			suffix: "\n  Roblox output before the failure:\n    [ERROR] traceback\n    [OUTPUT] tail",
		},
	])("should retain the failure code and ordered log tail: %j", ({ logTail, suffix }) => {
		expect.assertions(1);

		const task = {
			error: { code: "SCRIPT_ERROR", message: "boom" },
			ref: makePollContext().ref,
			state: "FAILED",
			user: "users/1",
		} satisfies FailedTask;
		const headline =
			"Roblox task failed (SCRIPT_ERROR): boom\n  task: universes/1/places/2/versions/7/luau-execution-sessions/session/tasks/task";

		expect(describeTaskFailure(task, logTail)).toBe(headline + suffix);
	});
});
