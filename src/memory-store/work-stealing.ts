import { createJsonWorkQueueWriter, type WorkQueueWriter } from "@isentinel/roblox-runner";

import { randomUUID } from "node:crypto";

const DEFAULT_TTL_SECONDS = 600;
const INVISIBILITY_BUFFER_SECONDS = 30;

export interface QueueItem {
	pkg: string;
	project: string;
}

interface PrepareWorkStealingOptions {
	/** Override the Open Cloud base URL (default: live Roblox endpoint). */
	baseUrl?: string | undefined;
	credentials: { apiKey: string; universeId: string };
	packages: ReadonlyArray<QueueItem>;
	perPackageTimeoutSeconds: number;
	/** Override the queue writer factory (default: real writer from runner). */
	queueFactory?: (queueId: string) => WorkQueueWriter<QueueItem>;
	/** TTL for queue items in seconds. Default 600 (10 min). */
	ttlSeconds?: number;
	/** Override the UUID generator (default: `crypto.randomUUID`). */
	uuid?: () => string;
}

interface PreparedWorkStealing {
	/**
	 * Materializer-side invisibility window = perPackageTimeoutSeconds + 30.
	 */
	invisibilityWindowSeconds: number;
	/** Per-run UUID-keyed queue name. */
	queueId: string;
}

/**
 * Generate a per-run queue ID, push every package onto it with the given TTL,
 * and report the queueId + the invisibility window the materializer should
 * use when popping. Each parallel OCALE task pops from this queue until it
 * is empty (work-stealing); the invisibility window covers per-package
 * execution plus a small buffer so a crashing task lets its in-flight
 * package become visible again to siblings.
 */
export async function prepareWorkStealingQueueAsync(
	options: PrepareWorkStealingOptions,
): Promise<PreparedWorkStealing> {
	const queueId = (options.uuid ?? randomUUID)();
	const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
	const queue =
		options.queueFactory?.(queueId) ??
		createJsonWorkQueueWriter<QueueItem>({
			apiKey: options.credentials.apiKey,
			baseUrl: options.baseUrl,
			queueId,
			universeId: options.credentials.universeId,
		});

	await queue.enqueueAsync(options.packages, { ttlMs: ttlSeconds * 1000 });

	return {
		invisibilityWindowSeconds: options.perPackageTimeoutSeconds + INVISIBILITY_BUFFER_SECONDS,
		queueId,
	};
}
