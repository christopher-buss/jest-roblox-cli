import {
	validDequeueBody,
	validInProgressTaskBody,
	validPublishResponseBody,
	validQueueItemBody,
} from "@bedrock-rbx/ocale/testing";

import { type } from "arktype";
import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { onTestFinished } from "vitest";

const createTaskRequestSchema = type({ script: "string", timeout: "string" });
const JSON_CONTENT_TYPE = "application/json";
const QUEUE_PATH_PATTERN = /\/memory-store\/queues\/([^/]+)(\/items(?::read|:discard)?)?$/;

export interface FakeOpenCloudTask {
	elapsedMs?: number;
	/**
	 * Error message returned when `state === "FAILED"`. Mirrors the live
	 * `error.message` shape the backend reads in `pollForCompletion`.
	 */
	errorMessage?: string;
	gameOutput?: string;
	jestOutput: string;
	/**
	 * Workspace-mode `pkg` field on the auto-wrapped entry. Required for
	 * work-stealing aggregation to match entries back to jobs.
	 */
	pkg?: string;
	pollsBeforeComplete?: number;
	/**
	 * Workspace-mode `project` field on the auto-wrapped entry. Combined
	 * with `pkg` it forms the lookup key the backend uses to disambiguate
	 * sibling projects within the same package.
	 */
	project?: string;
	/**
	 * Per-package snapshot writes returned on the auto-wrapped entry.
	 * Mirrors the envelope field captured by the staged materializer:
	 * each key is a DataModel-style virtual path resolved by the CLI's
	 * `writeSnapshots` against the per-package rojo project + rootDir.
	 */
	snapshotWrites?: Record<string, string>;
	/**
	 * Terminal state to return after `pollsBeforeComplete` is exhausted.
	 * Defaults to `"COMPLETE"`. Set to `"FAILED"` to drive the failure
	 * branch — the contract suite needs both to prove fake/live parity.
	 */
	state?: "COMPLETE" | "FAILED";
}

interface FakeOpenCloudCall {
	apiKey: string | undefined;
	method: string;
	url: string;
}

interface QueuedItem {
	id: string;
	value: Exclude<JSONValue, null>;
}

interface FakeOpenCloudServer {
	baseUrl: string;
	calls: Array<FakeOpenCloudCall>;
	queueAdds: Array<{ queue: string; value: Exclude<JSONValue, null> }>;
	queueDiscards: Array<{ id: string; queue: string }>;
	requests: Array<typeof createTaskRequestSchema.infer>;
	uploadCount: number;
}

export async function startFakeOpenCloudServer(
	tasks: Array<FakeOpenCloudTask>,
): Promise<FakeOpenCloudServer> {
	const calls: FakeOpenCloudServer["calls"] = [];
	const requests: FakeOpenCloudServer["requests"] = [];
	const queueAdds: FakeOpenCloudServer["queueAdds"] = [];
	const queueDiscards: FakeOpenCloudServer["queueDiscards"] = [];
	const queues = new Map<string, Array<QueuedItem>>();
	const taskQueue = [...tasks];
	const taskResults = new Map<string, FakeOpenCloudTask>();
	const pollCounts = new Map<string, number>();
	let uploadCount = 0;
	let taskIndex = 0;
	let itemSeq = 0;

	const server = createServer((request, response) => {
		const apiKeyHeader = request.headers["x-api-key"];
		calls.push({
			apiKey: typeof apiKeyHeader === "string" ? apiKeyHeader : undefined,
			method: request.method ?? "",
			url: request.url ?? "",
		});

		void handleRequest({
			pollCounts,
			queueAdds,
			queueDiscards,
			queues,
			request,
			requests,
			response,
			taskQueue,
			taskResults,
			updateItemSeq: () => {
				itemSeq += 1;
				return itemSeq;
			},
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
		calls,
		queueAdds,
		queueDiscards,
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

function handlePoll(options: {
	pollCounts: Map<string, number>;
	response: ServerResponse;
	taskResults: Map<string, FakeOpenCloudTask>;
	url: URL;
}): void {
	const { pollCounts, response, taskResults, url } = options;
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
		response.end(
			JSON.stringify(validInProgressTaskBody({ path: taskPath, state: "PROCESSING" })),
		);
		return;
	}

	if (queuedTask.state === "FAILED") {
		response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
		response.end(
			JSON.stringify(
				validInProgressTaskBody({
					error: {
						code: "SCRIPT_ERROR",
						message: queuedTask.errorMessage ?? "Execution failed",
					},
					path: taskPath,
					state: "FAILED",
				}),
			),
		);
		return;
	}

	response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
	response.end(
		JSON.stringify(
			validInProgressTaskBody({
				output: {
					results: [
						JSON.stringify({
							entries: [
								{
									elapsedMs: queuedTask.elapsedMs ?? 25,
									gameOutput: queuedTask.gameOutput,
									jestOutput: queuedTask.jestOutput,
									pkg: queuedTask.pkg,
									project: queuedTask.project,
									snapshotWrites: queuedTask.snapshotWrites,
								},
							],
						}),
					],
				},
				path: taskPath,
				state: "COMPLETE",
			}),
		),
	);
}

function parseQueuePath(pathname: string): undefined | { queue: string; suffix: string } {
	// /cloud/v2/universes/{universe}/memory-store/queues/{queue}{suffix}
	const match = QUEUE_PATH_PATTERN.exec(pathname);
	if (match === null) {
		return undefined;
	}

	return { queue: match[1] ?? "", suffix: match[2] ?? "" };
}

function handleQueueAdd(options: {
	parsed: unknown;
	queue: string;
	queueAdds: FakeOpenCloudServer["queueAdds"];
	queues: Map<string, Array<QueuedItem>>;
	response: ServerResponse;
	updateItemSeq: () => number;
}): void {
	const { parsed, queue, queueAdds, queues, response, updateItemSeq } = options;
	const itemValue = (parsed as { data: Exclude<JSONValue, null> }).data;
	queueAdds.push({ queue, value: itemValue });
	const itemId = `item-${updateItemSeq().toString()}`;
	const items = queues.get(queue) ?? [];
	items.push({ id: itemId, value: itemValue });
	queues.set(queue, items);
	response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
	response.end(
		JSON.stringify(
			validQueueItemBody({
				data: itemValue,
				path: `cloud/v2/universes/123/memory-store/queues/${queue}/items/${itemId}`,
				priority: 0,
			}),
		),
	);
}

function handleQueueRead(options: {
	queue: string;
	queues: Map<string, Array<QueuedItem>>;
	response: ServerResponse;
}): void {
	const { queue, queues, response } = options;
	const queued = queues.get(queue) ?? [];
	const next = queued.shift();
	queues.set(queue, queued);
	response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
	if (next === undefined) {
		response.end(JSON.stringify(validDequeueBody({ id: "read-empty", queueItems: [] })));
		return;
	}

	response.end(
		JSON.stringify(
			validDequeueBody({
				id: `read-${next.id}`,
				queueItems: [
					validQueueItemBody({
						data: next.value,
						path: `cloud/v2/universes/123/memory-store/queues/${queue}/items/${next.id}`,
						priority: 0,
					}),
				],
			}),
		),
	);
}

function handleQueueDiscard(options: {
	parsed: unknown;
	queue: string;
	queueDiscards: FakeOpenCloudServer["queueDiscards"];
	response: ServerResponse;
}): void {
	const { parsed, queue, queueDiscards, response } = options;
	const id = (parsed as { readId?: string }).readId ?? "";
	queueDiscards.push({ id, queue });
	response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
	response.end("{}");
}

async function handleQueueRequest(options: {
	body: string;
	queueAdds: FakeOpenCloudServer["queueAdds"];
	queueDiscards: FakeOpenCloudServer["queueDiscards"];
	queuePath: { queue: string; suffix: string };
	queues: Map<string, Array<QueuedItem>>;
	response: ServerResponse;
	updateItemSeq: () => number;
}): Promise<void> {
	const { body, queueAdds, queueDiscards, queuePath, queues, response, updateItemSeq } = options;
	const { queue, suffix } = queuePath;
	const parsed = body === "" ? {} : JSON.parse(body);

	switch (suffix) {
		case "/items": {
			handleQueueAdd({ parsed, queue, queueAdds, queues, response, updateItemSeq });
			return;
		}
		case "/items:discard": {
			handleQueueDiscard({ parsed, queue, queueDiscards, response });
			return;
		}
		case "/items:read": {
			handleQueueRead({ queue, queues, response });
			return;
		}
	}

	response.writeHead(404, { "content-type": JSON_CONTENT_TYPE });
	response.end(JSON.stringify({ error: { message: `Unknown queue suffix: ${suffix}` } }));
}

async function handleRequest(options: {
	pollCounts: Map<string, number>;
	queueAdds: FakeOpenCloudServer["queueAdds"];
	queueDiscards: FakeOpenCloudServer["queueDiscards"];
	queues: Map<string, Array<QueuedItem>>;
	request: IncomingMessage;
	requests: FakeOpenCloudServer["requests"];
	response: ServerResponse;
	taskQueue: Array<FakeOpenCloudTask>;
	taskResults: Map<string, FakeOpenCloudTask>;
	updateItemSeq: () => number;
	updateTaskIndex: () => number;
	updateUploadCount: () => number;
}): Promise<void> {
	const {
		pollCounts,
		queueAdds,
		queueDiscards,
		queues,
		request,
		requests,
		response,
		taskQueue,
		taskResults,
	} = options;
	const url = new URL(request.url ?? "/", "http://127.0.0.1");

	if (request.method === "POST" && url.pathname.endsWith("/versions")) {
		response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
		response.end(
			JSON.stringify(
				validPublishResponseBody({ versionNumber: options.updateUploadCount() }),
			),
		);
		return;
	}

	const queuePath = parseQueuePath(url.pathname);
	const { updateItemSeq } = options;
	if (request.method === "POST" && queuePath !== undefined) {
		await handleQueueRequest({
			body: await readBody(request),
			queueAdds,
			queueDiscards,
			queuePath,
			queues,
			response,
			updateItemSeq,
		});
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

		const taskIndex = options.updateTaskIndex();
		const taskPath = `universes/123/places/456/versions/1/luau-execution-sessions/session-${String(taskIndex)}/tasks/task-${String(taskIndex)}`;
		taskResults.set(taskPath, nextTask);
		pollCounts.set(taskPath, nextTask.pollsBeforeComplete ?? 0);
		response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
		response.end(JSON.stringify(validInProgressTaskBody({ path: taskPath })));
		return;
	}

	if (request.method === "GET" && url.pathname.startsWith("/cloud/v2/universes/")) {
		handlePoll({ pollCounts, response, taskResults, url });
		return;
	}

	response.writeHead(404, { "content-type": JSON_CONTENT_TYPE });
	response.end(JSON.stringify({ error: { message: `Unhandled route: ${url.pathname}` } }));
}
