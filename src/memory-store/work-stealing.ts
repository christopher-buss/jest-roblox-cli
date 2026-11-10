import { createJsonWorkQueueWriter, type WorkQueueWriter } from "@isentinel/roblox-runner";

import { randomUUID } from "node:crypto";

import type { WorkQueueItem as QueueItem } from "../protocol/embedded-payload-types.ts";
import { QUEUE_TTL_SECONDS } from "../protocol/limits.ts";

const INVISIBILITY_BUFFER_SECONDS = 30;

/** Queue ID and timing that the materializer reads the queue with. */
export interface PreparedWorkStealing {
	/** Materializer-side invisibility window, in seconds. */
	invisibilityWindowSeconds: number;
	/** Per-run UUID-keyed queue name. */
	queueId: string;
	/** TTL the items were pushed with; the runner reuses it on put-back. */
	ttlSeconds: number;
}

interface PrepareWorkStealingOptions {
	baseUrl?: string | undefined;
	credentials: { apiKey: string; universeId: string };
	packages: ReadonlyArray<QueueItem>;
	perPackageTimeoutSeconds: number;
	queueFactory?: (queueId: string) => WorkQueueWriter<QueueItem>;
	ttlSeconds?: number;
	uuid?: () => string;
}

/**
 * Push every package onto a fresh per-run work-stealing queue.
 * @param options - Credentials, packages, per-package timeout and test seams.
 * @returns Queue ID, invisibility window and item TTL.
 * @rejects When the queue writer fails to enqueue.
 */
export async function prepareWorkStealingQueueAsync(
	options: PrepareWorkStealingOptions,
): Promise<PreparedWorkStealing> {
	const queueId = (options.uuid ?? randomUUID)();
	const ttlSeconds = options.ttlSeconds ?? QUEUE_TTL_SECONDS;
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
		ttlSeconds,
	};
}
