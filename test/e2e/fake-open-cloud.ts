import { type } from "arktype";
import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { onTestFinished } from "vitest";

const createTaskRequestSchema = type({ script: "string", timeout: "string" });
const JSON_CONTENT_TYPE = "application/json";

export interface FakeOpenCloudTask {
	elapsedMs?: number;
	gameOutput?: string;
	jestOutput: string;
	pollsBeforeComplete?: number;
}

export interface FakeOpenCloudServer {
	baseUrl: string;
	requests: Array<typeof createTaskRequestSchema.infer>;
	uploadCount: number;
}

export async function startFakeOpenCloudServer(
	tasks: Array<FakeOpenCloudTask>,
): Promise<FakeOpenCloudServer> {
	const requests: FakeOpenCloudServer["requests"] = [];
	const taskQueue = [...tasks];
	const taskResults = new Map<string, FakeOpenCloudTask>();
	const pollCounts = new Map<string, number>();
	let uploadCount = 0;
	let taskIndex = 0;

	const server = createServer((request, response) => {
		void handleRequest({
			pollCounts,
			request,
			requests,
			response,
			taskQueue,
			taskResults,
			updateTaskIndex: () => {
				taskIndex += 1;
				return taskIndex;
			},
			updateUploadCount: () => {
				uploadCount += 1;
				return uploadCount;
			},
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});

	onTestFinished(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}

				resolve();
			});
		});
	});

	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Fake Open Cloud server failed to bind to a TCP port");
	}

	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		get uploadCount() {
			return uploadCount;
		},
	};
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Array<Uint8Array> = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}

	return Buffer.concat(chunks).toString("utf-8");
}

async function handleRequest(options: {
	pollCounts: Map<string, number>;
	request: IncomingMessage;
	requests: FakeOpenCloudServer["requests"];
	response: ServerResponse;
	taskQueue: Array<FakeOpenCloudTask>;
	taskResults: Map<string, FakeOpenCloudTask>;
	updateTaskIndex: () => number;
	updateUploadCount: () => number;
}): Promise<void> {
	const { pollCounts, request, requests, response, taskQueue, taskResults } = options;
	const url = new URL(request.url ?? "/", "http://127.0.0.1");

	if (request.method === "POST" && url.pathname.endsWith("/versions")) {
		response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
		response.end(JSON.stringify({ versionNumber: options.updateUploadCount() }));
		return;
	}

	if (request.method === "POST" && url.pathname.endsWith("/luau-execution-session-tasks")) {
		const body = await readBody(request);
		let parsed;
		try {
			parsed = createTaskRequestSchema.assert(JSON.parse(body));
		} catch {
			response.writeHead(400, { "content-type": JSON_CONTENT_TYPE });
			response.end(JSON.stringify({ error: { message: "Invalid request body" } }));
			return;
		}

		requests.push(parsed);

		const nextTask = taskQueue.shift();
		if (nextTask === undefined) {
			response.writeHead(500, { "content-type": JSON_CONTENT_TYPE });
			response.end(JSON.stringify({ error: { message: "No fake task queued" } }));
			return;
		}

		const taskPath = `mock/tasks/${options.updateTaskIndex()}`;
		taskResults.set(taskPath, nextTask);
		pollCounts.set(taskPath, nextTask.pollsBeforeComplete ?? 0);
		response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
		response.end(JSON.stringify({ path: taskPath }));
		return;
	}

	if (request.method === "GET" && url.pathname.startsWith("/cloud/v2/mock/tasks/")) {
		const taskPath = url.pathname.replace("/cloud/v2/", "");
		const remainingPolls = pollCounts.get(taskPath);
		const queuedTask = taskResults.get(taskPath);

		if (queuedTask === undefined || remainingPolls === undefined) {
			response.writeHead(404, { "content-type": JSON_CONTENT_TYPE });
			response.end(JSON.stringify({ error: { message: "Unknown fake task" } }));
			return;
		}

		if (remainingPolls > 0) {
			pollCounts.set(taskPath, remainingPolls - 1);
			response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
			response.end(JSON.stringify({ state: "PROCESSING" }));
			return;
		}

		response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
		response.end(
			JSON.stringify({
				output: {
					results: [
						JSON.stringify({
							entries: [
								{
									elapsedMs: queuedTask.elapsedMs ?? 25,
									gameOutput: queuedTask.gameOutput,
									jestOutput: queuedTask.jestOutput,
								},
							],
						}),
					],
				},
				state: "COMPLETE",
			}),
		);
		return;
	}

	response.writeHead(404, { "content-type": JSON_CONTENT_TYPE });
	response.end(JSON.stringify({ error: { message: `Unhandled route: ${url.pathname}` } }));
}
