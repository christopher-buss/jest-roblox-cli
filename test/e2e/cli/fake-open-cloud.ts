import { validBinaryInputBody, validPublishResponseBody } from "@bedrock-rbx/ocale/testing";

import { Buffer } from "node:buffer";
import {
	createServer,
	type IncomingMessage,
	type RequestListener,
	type Server,
	type ServerResponse,
} from "node:http";
import { assert, onTestFinished } from "vitest";

import { handleQueueRequest, parseQueuePath } from "#test/e2e/cli/fake-open-cloud-queues.ts";
import {
	type BootProbeAnswer,
	createState,
	type FakeOpenCloudServer,
	type FakeOpenCloudState,
	JSON_CONTENT_TYPE,
} from "#test/e2e/cli/fake-open-cloud-state.ts";
import {
	handleCreateTask,
	handleListLogs,
	handlePoll,
} from "#test/e2e/cli/fake-open-cloud-tasks.ts";

const EXECUTION_CLAIM_PATH_PATTERN =
	/\/memory-store\/sorted-maps\/jest-roblox-execution-v1\/items\/([^/]+)$/;
const BINARY_INPUT_SUFFIX = "/luau-execution-session-task-binary-inputs";
/** Where a task is created, on head or under `/versions/{v}`. */
export const TASK_CREATE_SUFFIX = "/luau-execution-session-tasks";

export function isTaskCreatePost(call: { method: string; url: string }): boolean {
	return call.method === "POST" && call.url.endsWith(TASK_CREATE_SUFFIX);
}

/**
 * Where the fake serves the presigned PUT it hands out. Live Open Cloud names
 * a storage host the API does not own, and the client PUTs there over a plain
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
	 * wrap — for outputs that are not Jest envelopes, such as the version-guard
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
	 * Answers each probe in turn; every probe past the end completes.
	 * `"complete"` returns the uploaded version. `"stall"` leaves only that
	 * probe PROCESSING indefinitely; queued test tasks answer independently.
	 */
	bootProbes?: Array<BootProbeAnswer>;
	executionClaim?: "missing" | { claimedAt: number; owner: string };
	/** Ordered failures returned before queued test tasks are accepted. */
	submitFailures?: Array<{
		body: JSONValue;
		headers?: Record<string, string>;
		status: number;
	}>;
	uploadConnectionResets?: number;
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

async function readBodyAsync(request: IncomingMessage): Promise<string> {
	const chunks: Array<Uint8Array> = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}

	return Buffer.concat(chunks).toString("utf-8");
}

function handlePublishVersion({
	response,
	state,
}: {
	response: ServerResponse;
	state: FakeOpenCloudState;
}): void {
	if (state.uploadConnectionResets > 0) {
		state.uploadConnectionResets -= 1;
		response.socket?.destroy();
		return;
	}

	state.counters.uploadCount += 1;
	response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
	response.end(
		JSON.stringify(validPublishResponseBody({ versionNumber: state.counters.uploadCount })),
	);
}

/**
 * Allocate a binary-input slot and hand back a presigned PUT the fake serves
 * itself, so the bytes a run sends are observable without a second fake.
 * @param options - Response and fake state.
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

/**
 * Record what the run PUT at a slot this server handed out.
 * @param options - Request body, response, fake state and request URL.
 */
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

/**
 * The routes a run only ever reads from, plus the unhandled-route answer.
 * @param options - Request method, response, fake state and request URL.
 */
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
		await readBodyAsync(request);
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

	if (request.method === "POST" && url.pathname.endsWith(TASK_CREATE_SUFFIX)) {
		handleCreateTask({ body: await readBodyAsync(request), response, state });
		return;
	}

	handleReadRequest({ method: request.method ?? "", response, state, url });
}

function createRequestListener(state: FakeOpenCloudState): RequestListener {
	return (request, response) => {
		response.shouldKeepAlive = false;
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
