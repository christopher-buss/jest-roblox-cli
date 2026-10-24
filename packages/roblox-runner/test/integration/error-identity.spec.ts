import { RateLimitError } from "@bedrock-rbx/ocale";
import {
	createFakeHttpClient,
	createFakeSleep,
	type FakeHttpClient,
} from "@bedrock-rbx/ocale/testing";
import {
	ExecutionTimeoutError,
	OcaleRunner,
	readRefusedPlaceVersion,
	TaskQuotaError,
	TaskStallError,
	TaskSubmitError,
} from "@isentinel/roblox-runner";
import { formatPlaceMismatch } from "@isentinel/roblox-runner/testing";

import { assert, describe, expect, it, vi } from "vitest";

const CREDENTIALS = { apiKey: "test-key", placeId: "456", universeId: "123" };

function taskBody(
	state: "COMPLETE" | "FAILED" | "PROCESSING" | "QUEUED",
	fields: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		createTime: "2026-01-01T00:00:00Z",
		path: "universes/123/places/456/versions/1/luau-execution-sessions/session-1/tasks/task-1",
		state,
		updateTime: "2026-01-01T00:00:00Z",
		user: "user-1",
		...fields,
	};
}

async function executeAsync(runner: OcaleRunner, pollBudget?: number): Promise<unknown> {
	return runner
		.executeScriptAsync({
			...(pollBudget === undefined ? {} : { pollBudget }),
			script: "return 1",
			timeout: 1000,
		})
		.catch((err: unknown) => err);
}

function makeRunner(http: FakeHttpClient): OcaleRunner {
	return new OcaleRunner(CREDENTIALS, { httpClient: http, sleep: createFakeSleep() });
}

describe("public error identity", () => {
	it("should reject a refused create with a TaskSubmitError that is no quota or timeout error", async () => {
		expect.assertions(3);

		const http = createFakeHttpClient();
		http.mockApiError({ message: "Bad request", statusCode: 400 });

		const caught = await executeAsync(makeRunner(http));

		expect(caught).toBeInstanceOf(TaskSubmitError);
		expect(caught).not.toBeInstanceOf(TaskQuotaError);
		expect(caught).not.toBeInstanceOf(ExecutionTimeoutError);
	});

	it("should reject a quota refusal with a TaskQuotaError that is also a TaskSubmitError", async () => {
		expect.assertions(2);

		const http = createFakeHttpClient();
		http.mockError(
			new RateLimitError("Rate limited", {
				details: { code: "RESOURCE_EXHAUSTED", message: "Too many tasks" },
				retryAfterSeconds: 0,
				statusCode: 429,
			}),
		);

		const caught = await executeAsync(makeRunner(http));

		expect(caught).toBeInstanceOf(TaskQuotaError);
		expect(caught).toBeInstanceOf(TaskSubmitError);
	});

	it("should reject an unanswered task with a TaskStallError that recovers the same task", async () => {
		expect.assertions(4);

		let clock = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		const http = createFakeHttpClient();
		http.mockResponse({ body: taskBody("QUEUED"), status: 200 });
		http.mockResponse({ body: taskBody("PROCESSING"), status: 200 });
		const runner = new OcaleRunner(CREDENTIALS, {
			httpClient: http,
			sleep: async (milliseconds) => {
				clock += milliseconds;
			},
		});

		const caught = await executeAsync(runner, 1);
		assert(caught instanceof TaskStallError);

		expect(caught).toBeInstanceOf(ExecutionTimeoutError);
		expect(caught).not.toBeInstanceOf(TaskSubmitError);

		http.mockResponse({
			body: taskBody("COMPLETE", { output: { results: ["late"] } }),
			status: 200,
		});

		await expect(caught.readResultAsync()).resolves.toMatchObject({ outputs: ["late"] });
		expect(http.requests.map(({ request }) => request.method)).toStrictEqual([
			"POST",
			"GET",
			"GET",
		]);
	});

	it("should reject a failed task with a plain Error rather than an infrastructure class", async () => {
		expect.assertions(3);

		const http = createFakeHttpClient();
		http.mockResponse({ body: taskBody("QUEUED"), status: 200 });
		http.mockResponse({
			body: taskBody("FAILED", { error: { code: "SCRIPT_ERROR", message: "boom" } }),
			status: 200,
		});
		http.mockResponse({ body: { luauExecutionSessionTaskLogs: [] }, status: 200 });

		const caught = await executeAsync(makeRunner(http));

		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(ExecutionTimeoutError);
		expect(caught).not.toBeInstanceOf(TaskSubmitError);
	});
});

describe("testing entry point", () => {
	it("should format a refusal the package root reads back", () => {
		expect.assertions(1);

		expect(readRefusedPlaceVersion(formatPlaceMismatch(7))).toBe(7);
	});
});
