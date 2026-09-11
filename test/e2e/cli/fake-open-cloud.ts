import {
	validBinaryInputBody,
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
import { assert, onTestFinished } from "vitest";

import { BOOT_PROBE_SCRIPT } from "../../../src/backends/open-cloud.ts";

const createTaskRequestSchema = type({
	"binaryInput?": "string",
	"script": "string",
	"timeout": "string",
});
const JSON_CONTENT_TYPE = "application/json";
const QUEUE_PATH_PATTERN = /\/memory-store\/queues\/([^/]+)(\/items(?::read|:discard)?)?$/;
const LOGS_SUFFIX_PATTERN = /\/logs$/;
const EXECUTION_CLAIM_PATH_PATTERN =
	/\/memory-store\/sorted-maps\/jest-roblox-execution-v1\/items\/([^/]+)$/;
const BINARY_INPUT_SUFFIX = "/luau-execution-session-task-binary-inputs";
/**
 * Where the fake serves the presigned PUT it hands out. Live Open Cloud names a
 * storage host the API does not own, and the client PUTs there over a plain
 * `fetch` rather than through its own transport — so the fake has to answer at
 * a real URL of its own for a spec to see the bytes at all.
 */
const BINARY_INPUT_UPLOAD_PATH = "/fake-binary-input-upload/";

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
	 * Structured log messages the task's `/logs` page returns. Read only on a
	 * failure — that is the one path the runner fetches logs for.
	 */
	logs?: ReadonlyArray<{ message: string; messageType: string }>;
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

/**
 * How the fake answers the CLI's boot probe. The probe is infrastructure, not
 * one of the run's tasks: it takes nothing off the queued task list and is
 * left out of `requests`, so a spec queues and asserts exactly the tasks it
 * cares about. Its HTTP traffic does appear in `calls`, which is the raw
 * request log and stays that way.
 */
export interface FakeOpenCloudOptions {
	/**
	 * `"complete"` returns the uploaded version. `"stall"` leaves only the
	 * probe PROCESSING indefinitely; queued test tasks answer independently.
	 */
	bootProbe?: "complete" | "stall";
	executionClaim?: "missing" | { claimedAt: number; owner: string };
}

/** One binary input the fake allocated, and the bytes that were PUT to it. */
interface FakeBinaryInput {
	/**
	 * Absent until the PUT lands, which is a create the run never followed up.
	 */
	body?: string | undefined;
	path: string;
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
	/** Every binary input this server allocated, in create order. */
	binaryInputs: Array<FakeBinaryInput>;
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
	/**
	 * Filled in once the server is listening; the create route hands it out.
	 */
	baseUrl: string;
	binaryInputs: FakeOpenCloudServer["binaryInputs"];
	bootProbe: NonNullable<FakeOpenCloudOptions["bootProbe"]>;
	calls: FakeOpenCloudServer["calls"];
	counters: { itemSeq: number; taskIndex: number; uploadCount: number };
	executionClaim: NonNullable<FakeOpenCloudOptions["executionClaim"]>;
	pollCounts: Map<string, number>;
	queueAdds: FakeOpenCloudServer["queueAdds"];
	queueDiscards: FakeOpenCloudServer["queueDiscards"];
	queues: Map<string, Array<QueuedItem>>;
	requests: FakeOpenCloudServer["requests"];
	taskQueue: Array<FakeOpenCloudTask>;
	taskResults: Map<string, FakeOpenCloudTask>;
}

export async function startFakeOpenCloudServerAsync(
	tasks: Array<FakeOpenCloudTask>,
	options: FakeOpenCloudOptions = {},
): Promise<FakeOpenCloudServer> {
	const state = createState(tasks, options);
	const server = createServer(createRequestListener(state));
	await listenOnEphemeralPortAsync(server);
	closeServerWhenTestFinishes(server);
	state.baseUrl = resolveBaseUrl(server);

	return {
		baseUrl: state.baseUrl,
		binaryInputs: state.binaryInputs,
		calls: state.calls,
		queueAdds: state.queueAdds,
		queueDiscards: state.queueDiscards,
		requests: state.requests,
		get uploadCount() {
			return state.counters.uploadCount;
		},
	};
}

function createState(
	tasks: Array<FakeOpenCloudTask>,
	options: FakeOpenCloudOptions,
): FakeOpenCloudState {
	return {
		baseUrl: "",
		binaryInputs: [],
		bootProbe: options.bootProbe ?? "complete",
		calls: [],
		counters: { itemSeq: 0, taskIndex: 0, uploadCount: 0 },
		executionClaim: options.executionClaim ?? { claimedAt: 0, owner: "fake-server" },
		pollCounts: new Map(),
		queueAdds: [],
		queueDiscards: [],
		queues: new Map(),
		requests: [],
		taskQueue: [...tasks],
		taskResults: new Map(),
	};
}

async function readBodyAsync(request: IncomingMessage): Promise<string> {
	const chunks: Array<Uint8Array> = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}

	return Buffer.concat(chunks).toString("utf-8");
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
	const parsed = body === "" ? {} : JSON.parse(body);

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

/**
 * Allocate a binary-input slot and hand back a presigned PUT the fake serves
 * itself, so the bytes a run sends are observable without a second fake.
 */
function handleCreateBinaryInput({
	response,
	state,
}: {
	response: ServerResponse;
	state: FakeOpenCloudState;
}): void {
	const index = String(state.binaryInputs.length + 1);
	const inputPath = `universes/123/luau-execution-session-task-binary-inputs/input-${index}`;
	state.binaryInputs.push({ path: inputPath });
	response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
	response.end(
		JSON.stringify(
			validBinaryInputBody({
				path: inputPath,
				uploadUri: `${state.baseUrl}${BINARY_INPUT_UPLOAD_PATH}${index}`,
			}),
		),
	);
}

/** Record what the run PUT at a slot this server handed out. */
function handleUploadBinaryInput({
	body,
	response,
	state,
	url,
}: {
	body: string;
	response: ServerResponse;
	state: FakeOpenCloudState;
	url: URL;
}): void {
	const index = Number(url.pathname.slice(BINARY_INPUT_UPLOAD_PATH.length));
	const input = state.binaryInputs[index - 1];
	if (input === undefined) {
		response.writeHead(404, { "content-type": JSON_CONTENT_TYPE });
		response.end(JSON.stringify({ error: { message: "Unknown binary input slot" } }));
		return;
	}

	input.body = body;
	response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
	response.end("{}");
}

/** Register a task under a fresh path and answer the submit with it. */
function acceptTask({
	queuedTask,
	response,
	state,
}: {
	queuedTask: FakeOpenCloudTask;
	response: ServerResponse;
	state: FakeOpenCloudState;
}): void {
	state.counters.taskIndex += 1;
	const taskIndex = String(state.counters.taskIndex);
	const taskPath = `universes/123/places/456/versions/1/luau-execution-sessions/session-${taskIndex}/tasks/task-${taskIndex}`;
	state.taskResults.set(taskPath, queuedTask);
	state.pollCounts.set(taskPath, queuedTask.pollsBeforeComplete ?? 0);
	response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
	response.end(JSON.stringify(validInProgressTaskBody({ path: taskPath })));
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

	if (parsed.script === BOOT_PROBE_SCRIPT) {
		acceptTask({
			queuedTask: {
				// A stalled task never reaches a terminal state.
				pollsBeforeComplete: state.bootProbe === "stall" ? Number.MAX_SAFE_INTEGER : 0,
				rawOutput: String(state.counters.uploadCount),
			},
			response,
			state,
		});
		return;
	}

	state.requests.push(parsed);

	const nextTask = state.taskQueue.shift();
	if (nextTask === undefined) {
		response.writeHead(500, { "content-type": JSON_CONTENT_TYPE });
		response.end(JSON.stringify({ error: { message: "No fake task queued" } }));
		return;
	}

	acceptTask({ queuedTask: nextTask, response, state });
}

/**
 * Serve a task's structured log page. Live Open Cloud writes these only once a
 * task is terminal, so a task the fake never completes has nothing to return —
 * the same empty page the live endpoint gives while a task is still running.
 */
function handleListLogs({
	response,
	state,
	url,
}: {
	response: ServerResponse;
	state: FakeOpenCloudState;
	url: URL;
}): void {
	const taskPath = url.pathname.replace("/cloud/v2/", "").replace(LOGS_SUFFIX_PATTERN, "");
	const queuedTask = state.taskResults.get(taskPath);
	const messages = queuedTask?.logs ?? [];

	response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
	response.end(
		JSON.stringify({
			luauExecutionSessionTaskLogs: [
				{
					path: `${taskPath}/logs/1`,
					structuredMessages: messages.map((entry) => {
						return { ...entry, createTime: "2026-01-01T00:00:00Z" };
					}),
				},
			],
		}),
	);
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

function handleExecutionClaimRead({
	response,
	state,
	url,
}: {
	response: ServerResponse;
	state: FakeOpenCloudState;
	url: URL;
}): boolean {
	const claimMatch = EXECUTION_CLAIM_PATH_PATTERN.exec(url.pathname);
	if (claimMatch === null) {
		return false;
	}

	if (state.executionClaim === "missing") {
		response.writeHead(404, { "content-type": JSON_CONTENT_TYPE });
		response.end(JSON.stringify({ error: { message: "Claim not found" } }));
		return true;
	}

	const encodedItemId = claimMatch[1];
	assert(encodedItemId !== undefined, "execution claim route must capture an item ID");
	const itemId = decodeURIComponent(encodedItemId);
	response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
	response.end(
		JSON.stringify({
			etag: "claim-etag",
			expireTime: "2026-09-11T20:00:00Z",
			path: `cloud/v2/universes/123/memory-store/sorted-maps/jest-roblox-execution-v1/items/${itemId}`,
			value: state.executionClaim,
		}),
	);
	return true;
}

/** The routes a run only ever reads from, plus the unhandled-route answer. */
function handleReadRequest({
	method,
	response,
	state,
	url,
}: {
	method: string;
	response: ServerResponse;
	state: FakeOpenCloudState;
	url: URL;
}): void {
	if (method === "GET" && handleExecutionClaimRead({ response, state, url })) {
		return;
	}

	if (method === "GET" && url.pathname.endsWith("/logs")) {
		handleListLogs({ response, state, url });
		return;
	}

	if (method === "GET" && url.pathname.startsWith("/cloud/v2/universes/")) {
		handlePoll({ response, state, url });
		return;
	}

	response.writeHead(404, { "content-type": JSON_CONTENT_TYPE });
	response.end(JSON.stringify({ error: { message: `Unhandled route: ${url.pathname}` } }));
}

async function handleRequestAsync({
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
		handleQueueRequest({ body: await readBodyAsync(request), queuePath, response, state });
		return;
	}

	if (request.method === "POST" && url.pathname.endsWith(BINARY_INPUT_SUFFIX)) {
		handleCreateBinaryInput({ response, state });
		return;
	}

	if (request.method === "PUT" && url.pathname.startsWith(BINARY_INPUT_UPLOAD_PATH)) {
		handleUploadBinaryInput({ body: await readBodyAsync(request), response, state, url });
		return;
	}

	if (request.method === "POST" && url.pathname.endsWith("/luau-execution-session-tasks")) {
		handleCreateTask({ body: await readBodyAsync(request), response, state });
		return;
	}

	handleReadRequest({ method: request.method ?? "", response, state, url });
}

function createRequestListener(state: FakeOpenCloudState): RequestListener {
	return (request, response) => {
		const apiKeyHeader = request.headers["x-api-key"];
		state.calls.push({
			apiKey: typeof apiKeyHeader === "string" ? apiKeyHeader : undefined,
			method: request.method ?? "",
			url: request.url ?? "",
		});

		void handleRequestAsync({ request, response, state });
	};
}

async function listenOnEphemeralPortAsync(server: Server): Promise<void> {
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
