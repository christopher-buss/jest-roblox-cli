import { validDequeueBody, validQueueItemBody } from "@bedrock-rbx/ocale/testing";

import type { ServerResponse } from "node:http";

import { type FakeOpenCloudState, JSON_CONTENT_TYPE } from "#test/e2e/cli/fake-open-cloud-state.ts";

const QUEUE_PATH_PATTERN = /\/memory-store\/queues\/([^/]+)(\/items(?::read|:discard)?)?$/;

export function parseQueuePath(pathname: string): undefined | { queue: string; suffix: string } {
	// /cloud/v2/universes/{universe}/memory-store/queues/{queue}{suffix}
	const match = QUEUE_PATH_PATTERN.exec(pathname);
	if (match === null) {
		return undefined;
	}

	return { queue: match[1] ?? "", suffix: match[2] ?? "" };
}

export function handleQueueRequest({
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

function isJsonObject(value: JSONValue): value is JSONObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The queue-add body's `data` field. Open Cloud rejects an absent or null
 * value, so a fake handed one is being driven wrongly — fail loudly rather
 * than enqueue a bogus item.
 * @param parsed - Parsed request body.
 * @returns The non-null `data` value.
 * @throws {Error} When `data` is absent or null.
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
