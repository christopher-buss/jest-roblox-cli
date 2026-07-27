import type { HttpClient, SleepFunc } from "@bedrock-rbx/ocale";
import type { EnqueueQueueItemParameters } from "@bedrock-rbx/ocale/storage";
import { StorageClient } from "@bedrock-rbx/ocale/storage";

export interface WorkQueueOptions<T> {
	readonly apiKey: string;
	readonly baseUrl?: string;
	readonly decode: (value: JSONValue) => T;
	readonly encode: (item: T) => unknown;
	readonly httpClient?: HttpClient;
	readonly queueId: string;
	readonly sleep?: SleepFunc;
	readonly universeId: string;
}

export interface ClaimedBatch<T> {
	readonly commit: () => Promise<void>;
	readonly items: ReadonlyArray<T>;
}

type QueueData = EnqueueQueueItemParameters["data"];

export class WorkQueue<T> {
	private readonly decode: (value: JSONValue) => T;
	private readonly encode: (item: T) => unknown;
	private readonly queueId: string;
	private readonly storage: StorageClient;
	private readonly universeId: string;

	constructor(options: WorkQueueOptions<T>) {
		this.decode = options.decode;
		this.encode = options.encode;
		this.queueId = options.queueId;
		this.universeId = options.universeId;
		this.storage = new StorageClient({
			apiKey: options.apiKey,
			...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
			...(options.httpClient !== undefined ? { httpClient: options.httpClient } : {}),
			...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
		});
	}

	public async claimAsync(count: number, invisibilityMs: number): Promise<ClaimedBatch<T>> {
		const invisibilityWindow = msToSecondsCeil(invisibilityMs);
		const result = await this.storage.queues.dequeue({
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

	public async enqueueAsync(
		items: ReadonlyArray<T>,
		options: { readonly ttlMs?: number } = {},
	): Promise<void> {
		const ttl = options.ttlMs !== undefined ? msToSecondsCeil(options.ttlMs) : undefined;
		for (const item of items) {
			const encoded = this.encode(item);
			if (encoded === null || encoded === undefined) {
				throw new Error(
					"WorkQueue encode() returned null/undefined; bedrock rejects null payloads",
				);
			}

			const parameters: EnqueueQueueItemParameters = {
				data: toQueueData(encoded),
				queueId: this.queueId,
				universeId: this.universeId,
				...(ttl !== undefined ? { ttl } : {}),
			};
			const result = await this.storage.queues.enqueue(parameters);
			if (!result.success) {
				throw new Error(`Failed to enqueue work item: ${result.err.message}`);
			}
		}
	}

	private async commitBatchAsync(readId: string): Promise<void> {
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

function msToSecondsCeil(ms: number): number {
	return Math.max(1, Math.ceil(ms / 1000));
}

/**
 * Narrows the null-guarded payload to bedrock's `Exclude<JSONValue, null>`.
 * Bedrock validates the full JSON shape at runtime; this is a single cast at
 * the type-system boundary, guarded above by the explicit null/undefined check.
 *
 * @param value - Non-null encoded payload from the caller's encode function.
 * @returns The same value, retyped to satisfy bedrock's enqueue parameters.
 */
function toQueueData(value: NonNullable<unknown>): QueueData {
	return value;
}
