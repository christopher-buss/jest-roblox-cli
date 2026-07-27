import {
	validDequeueBody,
	validInProgressTaskBody,
	validPublishResponseBody,
	validQueueItemBody,
} from "@bedrock-rbx/ocale/testing";

import { type } from "arktype";
import { Buffer } from "node:buffer";
import {
	createServer,
	type IncomingMessage,
	type RequestListener,
	type Server,
	type ServerResponse,
} from "node:http";
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
	/**
	 * Jest JSON payload wrapped into the envelope entry. Optional only when
	 * `rawOutput` supplies the task's results verbatim instead.
	 */
	jestOutput?: string;
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
	 * Verbatim `output.results[0]` for this task, bypassing the envelope
	 * wrap — for outputs that are not Jest envelopes, e.g. the version-guard
	 * race sentinel.
	 */
	rawOutput?: string;
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

/**
 * Mutable per-server state, threaded through every route handler. The
 * `counters` are read back by the returned server's `uploadCount` getter, so
 * they must stay one shared object rather than copied numbers.
 */
interface FakeOpenCloudState {
	calls: FakeOpenCloudServer["calls"];
	counters: { itemSeq: number; taskIndex: number; uploadCount: number };
	pollCounts: Map<string, number>;
	queueAdds: FakeOpenCloudServer["queueAdds"];
	queueDiscards: FakeOpenCloudServer["queueDiscards"];
	queues: Map<string, Array<QueuedItem>>;
	requests: FakeOpenCloudServer["requests"];
	taskQueue: Array<FakeOpenCloudTask>;
	taskResults: Map<string, FakeOpenCloudTask>;
}

export async function startFakeOpenCloudServer(
	tasks: Array<FakeOpenCloudTask>,
): Promise<FakeOpenCloudServer> {
	const state: FakeOpenCloudState = {
		calls: [],
		counters: { itemSeq: 0, taskIndex: 0, uploadCount: 0 },
		pollCounts: new Map(),
		queueAdds: [],
		queueDiscards: [],
		queues: new Map(),
		requests: [],
		taskQueue: [...tasks],
		taskResults: new Map(),
	};

	const server = createServer(createRequestListener(state));
	await listenOnEphemeralPort(server);
	closeServerWhenTestFinishes(server);

	return {
		baseUrl: resolveBaseUrl(server),
		calls: state.calls,
		queueAdds: state.queueAdds,
		queueDiscards: state.queueDiscards,
		requests: state.requests,
		get uploadCount() {
			return state.counters.uploadCount;
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

/** The auto-wrapped envelope entry returned when no `rawOutput` is supplied. */
function buildJestEnvelope(queuedTask: FakeOpenCloudTask): string {
	return JSON.stringify({
		entries: [
			{
				elapsedMs: queuedTask.elapsedMs ?? 25,
				gameOutput: queuedTask.gameOutput,
				jestOutput: queuedTask.jestOutput ?? "",
				pkg: queuedTask.pkg,
				project: queuedTask.project,
				snapshotWrites: queuedTask.snapshotWrites,
			},
		],
	});
}

function buildCompletedTaskBody({
	queuedTask,
	taskPath,
}: {
	queuedTask: FakeOpenCloudTask;
	taskPath: string;
}): ReturnType<typeof validInProgressTaskBody> {
	if (queuedTask.state === "FAILED") {
		return validInProgressTaskBody({
			error: {
				code: "SCRIPT_ERROR",
				message: queuedTask.errorMessage ?? "Execution failed",
			},
			path: taskPath,
			state: "FAILED",
		});
	}

	if (queuedTask.rawOutput !== undefined) {
		return validInProgressTaskBody({
			output: { results: [queuedTask.rawOutput] },
			path: taskPath,
			state: "COMPLETE",
		});
	}

	return validInProgressTaskBody({
		output: { results: [buildJestEnvelope(queuedTask)] },
		path: taskPath,
		state: "COMPLETE",
	});
}

function handlePoll({
	response,
	state,
	url,
}: {
	response: ServerResponse;
	state: FakeOpenCloudState;
	url: URL;
}): void {
	const taskPath = url.pathname.replace("/cloud/v2/", "");
	const remainingPolls = state.pollCounts.get(taskPath);
	const queuedTask = state.taskResults.get(taskPath);

	if (queuedTask === undefined || remainingPolls === undefined) {
		response.writeHead(404, { "content-type": JSON_CONTENT_TYPE });
		response.end(JSON.stringify({ error: { message: "Unknown fake task" } }));
		return;
	}

	if (remainingPolls > 0) {
		state.pollCounts.set(taskPath, remainingPolls - 1);
		response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
		response.end(
			JSON.stringify(validInProgressTaskBody({ path: taskPath, state: "PROCESSING" })),
		);
		return;
	}

	response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
	response.end(JSON.stringify(buildCompletedTaskBody({ queuedTask, taskPath })));
}

function parseQueuePath(pathname: string): undefined | { queue: string; suffix: string } {
	// /cloud/v2/universes/{universe}/memory-store/queues/{queue}{suffix}
	const match = QUEUE_PATH_PATTERN.exec(pathname);
	if (match === null) {
		return undefined;
	}

	return { queue: match[1] ?? "", suffix: match[2] ?? "" };
}

function isJsonObject(value: JSONValue): value is JSONObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The queue-add body's `data` field. Open Cloud rejects an absent or null
 * value, so a fake handed one is being driven wrongly — fail loudly rather than
 * enqueue a bogus item.
 */
function readItemData(parsed: JSONValue): Exclude<JSONValue, null> {
	const data = isJsonObject(parsed) ? parsed["data"] : undefined;
	if (data === undefined || data === null) {
		throw new Error("Queue add request body must carry a non-null `data` value");
	}

	return data;
}

function handleQueueAdd({
	parsed,
	queue,
	response,
	state,
}: {
	parsed: JSONValue;
	queue: string;
	response: ServerResponse;
	state: FakeOpenCloudState;
}): void {
	const itemValue = readItemData(parsed);
	state.queueAdds.push({ queue, value: itemValue });
	state.counters.itemSeq += 1;
	const itemId = `item-${state.counters.itemSeq.toString()}`;
	const items = state.queues.get(queue) ?? [];
	items.push({ id: itemId, value: itemValue });
	state.queues.set(queue, items);
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

function handleQueueRead({
	queue,
	response,
	state,
}: {
	queue: string;
	response: ServerResponse;
	state: FakeOpenCloudState;
}): void {
	const queued = state.queues.get(queue) ?? [];
	const next = queued.shift();
	state.queues.set(queue, queued);
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

function handleQueueDiscard({
	parsed,
	queue,
	response,
	state,
}: {
	parsed: JSONValue;
	queue: string;
	response: ServerResponse;
	state: FakeOpenCloudState;
}): void {
	const rawReadId = isJsonObject(parsed) ? parsed["readId"] : undefined;
	const id = typeof rawReadId === "string" ? rawReadId : "";
	state.queueDiscards.push({ id, queue });
	response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
	response.end("{}");
}

function handleQueueRequest({
	body,
	queuePath,
	response,
	state,
}: {
	body: string;
	queuePath: { queue: string; suffix: string };
	response: ServerResponse;
	state: FakeOpenCloudState;
}): void {
	const { queue, suffix } = queuePath;
	const parsed: JSONValue = body === "" ? {} : JSON.parse(body);

	switch (suffix) {
		case "/items": {
			handleQueueAdd({ parsed, queue, response, state });
			return;
		}
		case "/items:discard": {
			handleQueueDiscard({ parsed, queue, response, state });
			return;
		}
		case "/items:read": {
			handleQueueRead({ queue, response, state });
			return;
		}
	}

	response.writeHead(404, { "content-type": JSON_CONTENT_TYPE });
	response.end(JSON.stringify({ error: { message: `Unknown queue suffix: ${suffix}` } }));
}

function handlePublishVersion({
	response,
	state,
}: {
	response: ServerResponse;
	state: FakeOpenCloudState;
}): void {
	state.counters.uploadCount += 1;
	response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
	response.end(
		JSON.stringify(validPublishResponseBody({ versionNumber: state.counters.uploadCount })),
	);
}

function handleCreateTask({
	body,
	response,
	state,
}: {
	body: string;
	response: ServerResponse;
	state: FakeOpenCloudState;
}): void {
	let parsed;
	try {
		parsed = createTaskRequestSchema.assert(JSON.parse(body));
	} catch {
		response.writeHead(400, { "content-type": JSON_CONTENT_TYPE });
		response.end(JSON.stringify({ error: { message: "Invalid request body" } }));
		return;
	}

	state.requests.push(parsed);

	const nextTask = state.taskQueue.shift();
	if (nextTask === undefined) {
		response.writeHead(500, { "content-type": JSON_CONTENT_TYPE });
		response.end(JSON.stringify({ error: { message: "No fake task queued" } }));
		return;
	}

	state.counters.taskIndex += 1;
	const taskIndex = String(state.counters.taskIndex);
	const taskPath = `universes/123/places/456/versions/1/luau-execution-sessions/session-${taskIndex}/tasks/task-${taskIndex}`;
	state.taskResults.set(taskPath, nextTask);
	state.pollCounts.set(taskPath, nextTask.pollsBeforeComplete ?? 0);
	response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
	response.end(JSON.stringify(validInProgressTaskBody({ path: taskPath })));
}

async function handleRequest({
	request,
	response,
	state,
}: {
	request: IncomingMessage;
	response: ServerResponse;
	state: FakeOpenCloudState;
}): Promise<void> {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");

	if (request.method === "POST" && url.pathname.endsWith("/versions")) {
		handlePublishVersion({ response, state });
		return;
	}

	const queuePath = parseQueuePath(url.pathname);
	if (queuePath !== undefined && request.method === "POST") {
		handleQueueRequest({ body: await readBody(request), queuePath, response, state });
		return;
	}

	if (request.method === "POST" && url.pathname.endsWith("/luau-execution-session-tasks")) {
		handleCreateTask({ body: await readBody(request), response, state });
		return;
	}

	if (request.method === "GET" && url.pathname.startsWith("/cloud/v2/universes/")) {
		handlePoll({ response, state, url });
		return;
	}

	response.writeHead(404, { "content-type": JSON_CONTENT_TYPE });
	response.end(JSON.stringify({ error: { message: `Unhandled route: ${url.pathname}` } }));
}

function createRequestListener(state: FakeOpenCloudState): RequestListener {
	return (request, response) => {
		const apiKeyHeader = request.headers["x-api-key"];
		state.calls.push({
			apiKey: typeof apiKeyHeader === "string" ? apiKeyHeader : undefined,
			method: request.method ?? "",
			url: request.url ?? "",
		});

		void handleRequest({ request, response, state });
	};
}

async function listenOnEphemeralPort(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function closeServerWhenTestFinishes(server: Server): void {
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
}

function resolveBaseUrl(server: Server): string {
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Fake Open Cloud server failed to bind to a TCP port");
	}

	return `http://127.0.0.1:${address.port}`;
}
