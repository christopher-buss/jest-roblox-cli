import { validPublishResponseBody } from "@bedrock-rbx/ocale/testing";

import { Buffer } from "node:buffer";
import {
	createServer,
	type IncomingMessage,
	type RequestListener,
	type Server,
	type ServerResponse,
} from "node:http";
import { onTestFinished } from "vitest";

import { handleQueueRequest, parseQueuePath } from "#test/harness/fake-open-cloud-queues.ts";
import {
	type BootProbeAnswer,
	createState,
	type FakeOpenCloudServer,
	type FakeOpenCloudState,
	JSON_CONTENT_TYPE,
} from "#test/harness/fake-open-cloud-state.ts";
import {
	handleCreateTask,
	handleListLogs,
	handlePoll,
} from "#test/harness/fake-open-cloud-tasks.ts";

/** Where a task is created, on head or under `/versions/{v}`. */
export const TASK_CREATE_SUFFIX = "/luau-execution-session-tasks";

export interface FakeOpenCloudTask {
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
	 * Job index on the auto-wrapped entry. Defaults to the index the submitted
	 * script gives `pkg` and `project`.
	 */
	jobIndex?: number;
	/**
	 * Structured log messages the task's `/logs` page returns. Read only on a
	 * failure — that is the one path the runner fetches logs for.
	 */
	logs?: ReadonlyArray<{ message: string; messageType: string }>;
	/**
	 * Workspace package whose job index in the submitted script the entry
	 * takes.
	 */
	pkg?: string;
	pollsBeforeComplete?: number;
	/** With `pkg`, picks between sibling projects of one package. */
	project?: string;
	rawOutput?: string;
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
	/** Ordered failures returned before queued test tasks are accepted. */
	submitFailures?: Array<{
		body: JSONValue;
		headers?: Record<string, string>;
		status: number;
	}>;
	uploadConnectionResets?: number;
}

export function isTaskCreatePost(call: { method: string; url: string }): boolean {
	return call.method === "POST" && call.url.endsWith(TASK_CREATE_SUFFIX);
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

		void handleRequestAsync({ request, response, state }).catch((err: unknown) => {
			response.writeHead(500, { "content-type": JSON_CONTENT_TYPE });
			response.end(JSON.stringify({ error: { message: String(err) } }));
		});
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
