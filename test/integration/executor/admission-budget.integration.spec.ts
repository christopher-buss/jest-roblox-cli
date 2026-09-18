import { RateLimitError } from "@bedrock-rbx/ocale";
import { createFakeHttpClient, type FakeHttpClient } from "@bedrock-rbx/ocale/testing";
import { OcaleRunner } from "@isentinel/roblox-runner";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { openCloudExecutionBudgets } from "../../../src/backends/open-cloud-budgets.ts";

const SHORT_TIMEOUT_MS = 15_000;
const TASK_BODY = {
	createTime: "2026-01-01T00:00:00Z",
	path: "universes/123/places/456/versions/1/luau-execution-sessions/session/tasks/task",
	state: "PROCESSING",
	updateTime: "2026-01-01T00:00:00Z",
	user: "user-1",
};

function throttle(http: FakeHttpClient, remaining = 0): void {
	http.mockError(
		new RateLimitError("Create quota exhausted", {
			remaining,
			retryAfterSeconds: 60,
			statusCode: 429,
		}),
	);
}

async function runShortScriptAsync(http: FakeHttpClient) {
	const budgets = openCloudExecutionBudgets(SHORT_TIMEOUT_MS);
	const runner = new OcaleRunner(
		{ apiKey: "test-key", placeId: "456", universeId: "123" },
		{
			httpClient: http,
			sleep: async (ms) => {
				await new Promise<void>((resolve) => {
					setTimeout(resolve, ms);
				});
			},
		},
	);
	return runner.executeScriptAsync({
		retrySubmitTransportErrors: false,
		script: 'return "accepted"',
		submitBudget: budgets.submitBudget,
		submitCapacityBudget: budgets.submitCapacityBudget,
		timeout: SHORT_TIMEOUT_MS,
	});
}

describe("short task admission", () => {
	it("should survive competing create quota windows without extending the script deadline", async () => {
		expect.assertions(3);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const http = createFakeHttpClient();
		throttle(http);
		throttle(http);
		http.mockResponse({ body: TASK_BODY, status: 200 });
		http.mockResponse({
			body: { ...TASK_BODY, output: { results: ["accepted"] }, state: "COMPLETE" },
			status: 200,
		});
		const observed = runShortScriptAsync(http).catch((err: unknown) => err);
		await vi.advanceTimersByTimeAsync(121_000);

		await expect(observed).resolves.toMatchObject({ outputs: ["accepted"] });
		expect(http.requests.map(({ request }) => request.method)).toStrictEqual([
			"POST",
			"POST",
			"POST",
			"GET",
		]);
		expect(http.requests[1]!.request.body).toMatchObject({ timeout: "15s" });
	});

	it("should stop ordinary repeated throttling at the inactivity limit", async () => {
		expect.assertions(3);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const http = createFakeHttpClient();
		throttle(http, 3);
		throttle(http, 3);
		const observed = runShortScriptAsync(http).catch((err: unknown) => err);
		await vi.advanceTimersByTimeAsync(90_000);

		await expect(observed).resolves.toMatchObject({
			message: expect.stringContaining("90s inactivity limit; 495s maximum"),
		});
		expect(http.requests).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(405_000);

		expect(http.requests).toHaveLength(2);
	});

	it("should stop repeated valid quota waits at the absolute admission cap", async () => {
		expect.assertions(2);

		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const http = createFakeHttpClient();
		for (let index = 0; index < 9; index += 1) {
			throttle(http);
		}

		const observed = runShortScriptAsync(http).catch((err: unknown) => err);
		await vi.advanceTimersByTimeAsync(495_000);

		await expect(observed).resolves.toMatchObject({
			message: expect.stringContaining("495s maximum"),
		});
		expect(http.requests).toHaveLength(9);
	});
});
