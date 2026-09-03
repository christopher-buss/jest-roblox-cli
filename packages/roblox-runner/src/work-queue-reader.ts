import type { HttpClient, SleepFunc } from "@bedrock-rbx/ocale";
import type { StorageClient } from "@bedrock-rbx/ocale/storage";

import {
	createWorkQueueStorage,
	dequeueOrEmptyAsync,
	msToSecondsCeil,
} from "./work-queue-shared.ts";

export interface WorkQueueReaderOptions<T> {
	readonly apiKey: string;
	readonly baseUrl?: string | undefined;
	readonly decode: (value: JSONValue) => T;
	readonly httpClient?: HttpClient;
	readonly queueId: string;
	readonly sleep?: SleepFunc;
	readonly universeId: string;
}

export interface ClaimedBatch<T> {
	readonly commit: () => Promise<void>;
	readonly items: ReadonlyArray<T>;
}

export interface WorkQueueReader<T> {
	/**
	 * Claim up to `count` items, holding them invisible to other consumers for
	 * `invisibilityMs`. A queue with nothing visible is not an error: it yields
	 * an empty batch, so a consumer can poll one until work arrives.
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
		this.storage = createWorkQueueStorage(options);
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

export function createWorkQueueReader<T>(options: WorkQueueReaderOptions<T>): WorkQueueReader<T> {
	return new OpenCloudWorkQueueReader(options);
}
