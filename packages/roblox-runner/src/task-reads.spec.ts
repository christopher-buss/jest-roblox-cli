import { NetworkError } from "@bedrock-rbx/ocale";
import { LuauExecutionClient } from "@bedrock-rbx/ocale/luau-execution";
import { createFakeHttpClient } from "@bedrock-rbx/ocale/testing";

import { describe, expect, it, vi } from "vitest";

import { TaskReads } from "./task-reads.ts";

const TASK_PATH =
	"universes/123/places/456/versions/1/luau-execution-sessions/session-1/tasks/task-1";
const REF = {
	placeId: "456",
	sessionId: "session-1",
	taskId: "task-1",
	universeId: "123",
	versionId: "1",
};
function makeReads() {
	const http = createFakeHttpClient();
	const client = new LuauExecutionClient({ apiKey: "key", httpClient: http, maxRetries: 0 });
	return { client, http, reads: new TaskReads(client) };
}

function logsBody(count: number) {
	return {
		luauExecutionSessionTaskLogs: [
			{
				path: `${TASK_PATH}/logs/1`,
				structuredMessages: Array.from({ length: count }, (_, index) => {
					return {
						createTime: "2026-01-01T00:00:00Z",
						message: `line ${String(index)}`,
						messageType: "OUTPUT",
					};
				}),
			},
		],
	};
}

describe(TaskReads, () => {
	it("should poll only the accepted task and retain the observation signal", async () => {
		expect.assertions(3);

		const { http, reads } = makeReads();
		http.mockResponse({
			body: {
				createTime: "2026-01-01T00:00:00Z",
				output: { results: ["done"] },
				path: TASK_PATH,
				state: "COMPLETE",
				updateTime: "2026-01-01T00:00:01Z",
				user: "user-1",
			},
			status: 200,
		});
		const observation = new AbortController();

		await expect(
			reads.pollAsync({
				deadlineMs: Date.now() + 1000,
				ref: REF,
				signal: observation.signal,
				timeoutMs: 1000,
			}),
		).resolves.toMatchObject({ data: { state: "COMPLETE" }, success: true });
		expect(http.requests[0]!.request.url).toBe(`/cloud/v2/${TASK_PATH}?view=BASIC`);

		observation.abort("caller stopped observing");

		expect(http.requests[0]!.config.signal!.reason).toBe("caller stopped observing");
	});

	it("should return only the newest twenty terminal log messages", async () => {
		expect.assertions(2);

		const { http, reads } = makeReads();
		http.mockResponse({ body: logsBody(25), status: 200 });
		const observation = new AbortController();

		await expect(
			reads.readFailureLogTailAsync({ ref: REF, signal: observation.signal }),
		).resolves.toStrictEqual(
			Array.from({ length: 20 }, (_, index) => `[OUTPUT] line ${String(index + 5)}`),
		);
		expect(http.requests[0]!.config.signal).toBe(observation.signal);
	});

	it("should retain an empty terminal log page", async () => {
		expect.assertions(1);

		const { http, reads } = makeReads();
		http.mockResponse({ body: logsBody(0), status: 200 });

		await expect(
			reads.readFailureLogTailAsync({ ref: REF, signal: undefined }),
		).resolves.toStrictEqual([]);
	});

	it("should tolerate rejected log requests without masking the task failure", async () => {
		expect.assertions(1);

		const { http, reads } = makeReads();
		http.mockApiError({ message: "logs forbidden", statusCode: 403 });

		await expect(
			reads.readFailureLogTailAsync({ ref: REF, signal: undefined }),
		).resolves.toStrictEqual([]);
	});

	it("should tolerate a throwing transport without masking the task failure", async () => {
		expect.assertions(1);

		const { http, reads } = makeReads();
		vi.spyOn(http, "request").mockRejectedValue(new Error("socket failed"));

		await expect(
			reads.readFailureLogTailAsync({ ref: REF, signal: undefined }),
		).resolves.toStrictEqual([]);
	});
});

describe("recovery request shape", () => {
	it("should omit absent deadlines and signals from SDK recovery options", async () => {
		expect.assertions(3);

		const { client, reads } = makeReads();
		const refusal = { err: new NetworkError("offline"), success: false } satisfies Awaited<
			ReturnType<typeof client.tasks.pollUntilDone>
		>;
		const poll = vi.spyOn(client.tasks, "pollUntilDone").mockResolvedValue(refusal);

		await expect(reads.pollAsync({ ref: REF, timeoutMs: 1000 })).resolves.toBe(refusal);
		expect(poll.mock.calls[0]![1]).not.toHaveProperty("deadlineMs");
		expect(poll.mock.calls[0]![1]).not.toHaveProperty("signal");
	});
});
