import { LuauExecutionClient } from "@bedrock-rbx/ocale/luau-execution";

import { createServer } from "node:http";
import { describe, expect, it, onTestFinished, vi } from "vitest";

interface ThrottleResponse {
	readonly name: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly waitMs: number;
}

async function startThrottleServerAsync({ headers }: ThrottleResponse) {
	let requestCount = 0;
	const server = createServer((_request, response) => {
		requestCount += 1;
		response.setHeader("content-type", "application/json");
		if (requestCount === 1) {
			response.writeHead(429, headers);
			response.end(
				JSON.stringify({
					code: "RESOURCE_EXHAUSTED",
					message: "Too many tasks already active for this place",
				}),
			);
			return;
		}

		response.end(
			JSON.stringify({
				createTime: "2026-01-01T00:00:00Z",
				path: "universes/123/places/456/versions/1/luau-execution-sessions/session/tasks/task",
				state: "PROCESSING",
				updateTime: "2026-01-01T00:00:00Z",
				user: "user-1",
			}),
		);
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	onTestFinished(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error === undefined) {
					resolve();
					return;
				}

				reject(error);
			});
		});
	});

	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Expected the throttle server to listen on a TCP port");
	}

	return {
		baseUrl: `http://127.0.0.1:${String(address.port)}`,
		requestCount: () => requestCount,
	};
}

describe("submit throttling", () => {
	it.for<ThrottleResponse>([
		{
			name: "active task capacity",
			headers: {
				"x-ratelimit-remaining": "3",
				"x-ratelimit-reset": "41",
			},
			waitMs: 1000,
		},
		{
			name: "gateway Retry-After",
			headers: {
				"retry-after": "5",
				"x-ratelimit-remaining": "0",
				"x-ratelimit-reset": "32",
			},
			waitMs: 32_000,
		},
		{
			name: "exhausted rate window",
			headers: {
				"x-ratelimit-remaining": "0",
				"x-ratelimit-reset": "32",
			},
			waitMs: 32_000,
		},
		{
			name: "immediate Retry-After",
			headers: {
				"retry-after": "0",
				"x-ratelimit-remaining": "0",
				"x-ratelimit-reset": "32",
			},
			waitMs: 32_000,
		},
		{
			name: "longer gateway Retry-After",
			headers: {
				"retry-after": "60",
				"x-ratelimit-remaining": "0",
				"x-ratelimit-reset": "32",
			},
			waitMs: 60_000,
		},
		{
			name: "active task capacity with Retry-After",
			headers: {
				"retry-after": "5",
				"x-ratelimit-remaining": "3",
				"x-ratelimit-reset": "41",
			},
			waitMs: 5000,
		},
		{
			name: "throttle without headers",
			headers: {},
			waitMs: 1000,
		},
	])("should retry $name after $waitMs ms", async (throttle) => {
		expect.assertions(3);

		let clock = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		const waits: Array<number> = [];
		const server = await startThrottleServerAsync(throttle);
		const client = new LuauExecutionClient({
			apiKey: "test-key",
			baseUrl: server.baseUrl,
			maxRetries: 1,
			sleep: async (ms) => {
				waits.push(ms);
				clock += ms;
			},
		});

		const result = await client.tasks.submit({
			placeId: "456",
			script: "return true",
			universeId: "123",
		});

		expect(result.success).toBeTrue();
		expect(server.requestCount()).toBe(2);
		expect(waits).toStrictEqual([throttle.waitMs]);
	});
});
