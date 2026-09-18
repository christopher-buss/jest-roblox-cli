import { RateLimitError } from "@bedrock-rbx/ocale";
import { createFakeHttpClient } from "@bedrock-rbx/ocale/testing";

import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import { createSubmitBudgetController, OcaleRunner } from "./ocale-runner.ts";

const CREDENTIALS = { apiKey: "test-key", placeId: "456", universeId: "123" };
const OPTIONS = {
	placeVersion: 1,
	script: "return 1",
	submitBudget: 90_000,
	submitCapacityBudget: 405_000,
	timeout: 300_000,
};
const COMPLETE = {
	createTime: "2026-01-01T00:00:00Z",
	output: { results: [1] },
	path: "universes/123/places/456/versions/1/luau-execution-sessions/session/tasks/task",
	state: "COMPLETE",
	updateTime: "2026-01-01T00:00:00Z",
	user: "user-1",
};

async function sleepAsync(milliseconds: number, signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		function finish(): void {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}

		const timer = setTimeout(finish, milliseconds);
		function onAbort(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(new Error("sleep aborted"));
		}

		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted === true) {
			onAbort();
		}
	});
}

function useClock(): void {
	vi.useFakeTimers();
	onTestFinished(() => {
		vi.useRealTimers();
	});
}

describe("sDK admission waits", () => {
	it("should exclude time behind other submissions in the static create queue", async () => {
		expect.assertions(3);

		useClock();
		const http = createFakeHttpClient();
		const send = http.request.bind(http);
		vi.spyOn(http, "request").mockImplementation(async (request, config) => {
			http.mockResponse({ body: COMPLETE, status: 200 });
			return send(request, config);
		});
		const runner = new OcaleRunner(CREDENTIALS, { httpClient: http, sleep: sleepAsync });
		const observations = Array.from({ length: 14 }, async () => {
			return runner.executeScriptAsync(OPTIONS).catch((err: unknown) => err);
		});
		await vi.advanceTimersByTimeAsync(110_000);

		await expect(Promise.all(observations)).resolves.toStrictEqual(
			Array.from({ length: 14 }, () => expect.objectContaining({ outputs: ["1"] })),
		);
		expect(http.requests.filter(({ request }) => request.method === "POST")).toHaveLength(14);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should cancel a queued caller without consuming a later submit slot", async () => {
		expect.assertions(4);

		useClock();
		const http = createFakeHttpClient();
		const send = http.request.bind(http);
		vi.spyOn(http, "request").mockImplementation(async (request, config) => {
			http.mockResponse({ body: COMPLETE, status: 200 });
			return send(request, config);
		});
		const runner = new OcaleRunner(CREDENTIALS, { httpClient: http, sleep: sleepAsync });
		const active = Array.from({ length: 13 }, async () => runner.executeScriptAsync(OPTIONS));
		const controller = new AbortController();
		const canceled = runner
			.executeScriptAsync({ ...OPTIONS, observationSignal: controller.signal })
			.catch((err: unknown) => err);
		await vi.advanceTimersByTimeAsync(1000);
		controller.abort("no longer needed");

		await expect(canceled).resolves.toMatchObject({ message: "Request aborted" });

		await vi.advanceTimersByTimeAsync(99_000);

		await expect(Promise.all(active)).resolves.toHaveLength(13);
		expect(http.requests.filter(({ request }) => request.method === "POST")).toHaveLength(13);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should exclude a successful response's quota wait before the next HTTP request", async () => {
		expect.assertions(3);

		useClock();
		const http = createFakeHttpClient();
		http.mockResponse({
			body: COMPLETE,
			headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" },
			status: 200,
		});
		http.mockResponse({ body: COMPLETE, status: 200 });
		http.mockResponse({ body: COMPLETE, status: 200 });
		http.mockResponse({ body: COMPLETE, status: 200 });
		const send = http.request.bind(http);
		vi.spyOn(http, "request")
			.mockImplementationOnce(send)
			.mockImplementationOnce(send)
			.mockImplementationOnce(async (request, config) => {
				await sleepAsync(40_000);
				return send(request, config);
			});
		const runner = new OcaleRunner(CREDENTIALS, { httpClient: http, sleep: sleepAsync });
		await runner.executeScriptAsync(OPTIONS);
		const observed = runner.executeScriptAsync(OPTIONS).catch((err: unknown) => err);
		await vi.advanceTimersByTimeAsync(59_999);

		expect(http.requests).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(40_001);

		await expect(observed).resolves.toMatchObject({ outputs: ["1"] });
		expect(http.requests).toHaveLength(4);
	});

	it("should charge a stalled HTTP request after a quota gate against inactivity", async () => {
		expect.assertions(3);

		useClock();
		const http = createFakeHttpClient();
		http.mockResponse({
			body: COMPLETE,
			headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" },
			status: 200,
		});
		http.mockResponse({ body: COMPLETE, status: 200 });
		const send = http.request.bind(http);
		vi.spyOn(http, "request")
			.mockImplementationOnce(send)
			.mockImplementationOnce(send)
			.mockImplementationOnce(async () => new Promise(() => {}));
		const runner = new OcaleRunner(CREDENTIALS, { httpClient: http, sleep: sleepAsync });
		await runner.executeScriptAsync(OPTIONS);
		const settled = vi.fn<(value: unknown) => void>();
		const observed = runner.executeScriptAsync(OPTIONS).catch(settled);
		await vi.advanceTimersByTimeAsync(149_999);

		expect(settled).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		await observed;

		expect(settled).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ message: expect.stringContaining("90s inactivity limit") }),
		);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should cancel both a sleeping quota gate and its queued follower immediately", async () => {
		expect.assertions(4);

		useClock();
		const http = createFakeHttpClient();
		http.mockResponse({
			body: COMPLETE,
			headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "600" },
			status: 200,
		});
		http.mockResponse({ body: COMPLETE, status: 200 });
		const runner = new OcaleRunner(CREDENTIALS, { httpClient: http, sleep: sleepAsync });
		await runner.executeScriptAsync(OPTIONS);
		const first = new AbortController();
		const second = new AbortController();
		const firstResult = runner
			.executeScriptAsync({ ...OPTIONS, observationSignal: first.signal })
			.catch((err: unknown) => err);
		const secondResult = runner
			.executeScriptAsync({ ...OPTIONS, observationSignal: second.signal })
			.catch((err: unknown) => err);
		await vi.advanceTimersByTimeAsync(1000);
		second.abort("follower stopped");

		await expect(secondResult).resolves.toMatchObject({ message: "Request aborted" });

		first.abort("first stopped");

		await expect(firstResult).resolves.toMatchObject({ message: "Request aborted" });
		expect(http.requests).toHaveLength(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should not credit a quota retry again when it crosses the SDK gate", async () => {
		expect.assertions(3);

		useClock();
		const http = createFakeHttpClient();
		http.mockError(new RateLimitError("quota", { remaining: 0, retryAfterSeconds: 60 }));
		const send = http.request.bind(http);
		vi.spyOn(http, "request")
			.mockImplementationOnce(send)
			.mockImplementationOnce(async () => new Promise(() => {}));
		const runner = new OcaleRunner(CREDENTIALS, { httpClient: http, sleep: sleepAsync });
		const settled = vi.fn<(value: unknown) => void>();
		const observed = runner.executeScriptAsync(OPTIONS).catch(settled);
		await vi.advanceTimersByTimeAsync(149_999);

		expect(settled).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		await observed;

		expect(settled).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ message: expect.stringContaining("90s inactivity limit") }),
		);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("submission wait accounting", () => {
	it("should exclude overlapping waits once and preserve spent inactivity", async () => {
		expect.assertions(3);

		useClock();
		const cancelSubmitting = vi.fn<() => void>();
		const budget = createSubmitBudgetController({
			budgetMs: 90_000,
			cancelSubmitting,
			capacityBudgetMs: 405_000,
		});
		const observed = budget.raceAsync(new Promise<never>(() => {})).catch(String);
		await vi.advanceTimersByTimeAsync(60_000);
		const first = budget.pause();
		assert(first !== undefined);
		await vi.advanceTimersByTimeAsync(20_000);
		const second = budget.pause();
		assert(second !== undefined);
		await vi.advanceTimersByTimeAsync(20_000);
		first();
		first();
		await vi.advanceTimersByTimeAsync(20_000);
		second();
		await vi.advanceTimersByTimeAsync(29_999);

		expect(cancelSubmitting).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);

		expect(cancelSubmitting).toHaveBeenCalledOnce();
		await expect(observed).resolves.toContain("90s inactivity limit");
	});

	it("should not refund waiting time before genuine progress renewed inactivity", async () => {
		expect.assertions(3);

		useClock();
		const cancelSubmitting = vi.fn<() => void>();
		const budget = createSubmitBudgetController({
			budgetMs: 90_000,
			cancelSubmitting,
			capacityBudgetMs: 405_000,
		});
		const observed = budget.raceAsync(new Promise<never>(() => {})).catch(String);
		const finish = budget.pause();
		assert(finish !== undefined);
		await vi.advanceTimersByTimeAsync(60_000);
		budget.progress("new blocker");
		await vi.advanceTimersByTimeAsync(30_000);
		finish();
		await vi.advanceTimersByTimeAsync(89_999);

		expect(cancelSubmitting).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);

		expect(cancelSubmitting).toHaveBeenCalledOnce();
		await expect(observed).resolves.toContain("90s inactivity limit");
	});

	it("should keep the absolute deadline active and ignore cleanup after settlement", async () => {
		expect.assertions(4);

		useClock();
		const cancelSubmitting = vi.fn<() => void>();
		const budget = createSubmitBudgetController({
			budgetMs: 90_000,
			cancelSubmitting,
			capacityBudgetMs: 405_000,
		});
		const observed = budget.raceAsync(new Promise<never>(() => {})).catch(String);
		const finish = budget.pause();
		assert(finish !== undefined);
		await vi.advanceTimersByTimeAsync(495_000);
		finish();
		finish();

		await expect(observed).resolves.toContain("495s maximum");
		expect(budget.pause()).toBeUndefined();
		expect(cancelSubmitting).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
});
