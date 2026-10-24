import type { StorageClient } from "@bedrock-rbx/ocale/storage";

import type { PacedConnection } from "./client-options.ts";
import { createStorageClient } from "./client-options.ts";
import { dequeueOrEmptyAsync, msToSecondsCeil } from "./work-queue-shared.ts";

/**
 * Queue transport and consumer decoding policy.
 *
 * @template T
 */
export interface WorkQueueReaderOptions<T> extends PacedConnection {
	/**
	 * Parse each SDK JSON value into the consumer domain type.
	 */
	readonly decode: (value: JSONValue) => T;
	/**
	 * Run-owned queue shared with the Luau workers.
	 */
	readonly queueId: string;
}

/**
 * Decoded claim with its own acknowledgement operation.
 *
 * @template T
 */
export interface ClaimedBatch<T> {
	/**
	 * Acknowledge this claim; empty claims perform no discard.
	 */
	readonly commit: () => Promise<void>;
	/**
	 * Decoded values from this claim, in queue order.
	 */
	readonly items: ReadonlyArray<T>;
}

/**
 * Claims work without interpreting empty queues as errors.
 *
 * @template T
 */
export interface WorkQueueReader<T> {
	/**
	 * Claim up to `count` items, holding them invisible to other consumers for
	 * `invisibilityMs`. A queue with nothing visible is not an error: it yields
	 * an empty batch, so a consumer can poll one until work arrives.
	 * @param count - Maximum number of items to claim.
	 * @param invisibilityMs - Claim invisibility window in milliseconds.
	 * @returns Decoded claimed items and their acknowledgement handle.
	 */
	claimAsync(count: number, invisibilityMs: number): Promise<ClaimedBatch<T>>;
}

class OpenCloudWorkQueueReader<T> implements WorkQueueReader<T> {
	private readonly decode: (value: JSONValue) => T;
	private readonly queueId: string;
	private readonly storage: StorageClient;
	private readonly universeId: string;

	constructor(options: WorkQueueReaderOptions<T>) {
		this.decode = options.decode;
		this.queueId = options.queueId;
		this.storage = createStorageClient(options);
		this.universeId = options.universeId;
	}

	public async claimAsync(count: number, invisibilityMs: number): Promise<ClaimedBatch<T>> {
		const invisibilityWindow = msToSecondsCeil(invisibilityMs);
		const result = await dequeueOrEmptyAsync(this.storage, {
			count,
			invisibilityWindow,
			queueId: this.queueId,
			universeId: this.universeId,
		});
		if (!result.success) {
			throw new Error(`Failed to claim work items: ${result.err.message}`);
		}

		const { readId } = result.data;
		const items = result.data.items.map((item) => this.decode(item.data));
		return {
			commit: async () => this.commitBatchAsync(readId),
			items,
		};
	}

	/**
	 * Discard the claim, so the items never resurface. An empty read yields no
	 * `readId` and so has nothing to discard.
	 * @param readId - Opaque receipt, absent for an empty claim.
	 * @rejects When the discard request fails or the server refuses it.
	 */
	private async commitBatchAsync(readId: string | undefined): Promise<void> {
		if (readId === undefined) {
			return;
		}

		const result = await this.storage.queues.discard({
			queueId: this.queueId,
			readId,
			universeId: this.universeId,
		});
		if (!result.success) {
			throw new Error(`Failed to commit work batch: ${result.err.message}`);
		}
	}
}

/**
 * Bind transport and decoding to one work queue.
 * @param options - Queue identity, transport and payload decoder.
 * @returns Queue reader bound to the supplied transport and decoder.
 * @template T
 */
export function createWorkQueueReader<T>(options: WorkQueueReaderOptions<T>): WorkQueueReader<T> {
	return new OpenCloudWorkQueueReader(options);
}
