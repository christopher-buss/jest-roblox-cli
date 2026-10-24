import type { EnqueueQueueItemParameters, StorageClient } from "@bedrock-rbx/ocale/storage";

import type { PacedConnection } from "./client-options.ts";
import { createStorageClient } from "./client-options.ts";
import type { QueueData } from "./work-queue-shared.ts";
import { msToSecondsCeil } from "./work-queue-shared.ts";

/**
 * Queue transport and producer encoding policy.
 *
 * @template T
 */
export interface WorkQueueWriterOptions<T> extends PacedConnection {
	/**
	 * Convert domain work into the MemoryStore JSON payload.
	 */
	readonly encode: (item: T) => QueueData;
	/**
	 * Run-owned queue shared with the Luau workers.
	 */
	readonly queueId: string;
}

/**
 * Queue transport for work already compatible with JSON.
 */
export interface JsonWorkQueueWriterOptions extends PacedConnection {
	/**
	 * Run-owned queue shared with the Luau workers.
	 */
	readonly queueId: string;
}

/**
 * Produces work without holding consumer claims.
 *
 * @template T
 */
export interface WorkQueueWriter<T> {
	/**
	 * Publish items in order with an optional server-rounded lifetime.
	 *
	 * @param items - Domain values to enqueue in order.
	 * @param options - Optional payload lifetime and queue priority.
	 */
	enqueueAsync(
		items: ReadonlyArray<T>,
		options?: {
			/**
			 * Item lifetime in milliseconds, rounded upward to server seconds.
			 */
			readonly ttlMs?: number;
		},
	): Promise<void>;
}

/**
 * Host-side queue control used by protocols that settle worker receipts.
 * @template T
 */
export interface WorkQueueHost<T> extends WorkQueueWriter<T> {
	/**
	 * Discard a worker claim using its opaque receipt.
	 *
	 * @param receipt - Opaque worker claim receipt.
	 */
	acknowledgeAsync(receipt: string): Promise<void>;
}

type JsonCompatible<T> = T extends boolean | null | number | string
	? T
	: T extends (...arguments_: Array<never>) => void
		? never
		: T extends object
			? { [Key in keyof T]: JsonCompatible<T[Key]> }
			: never;

type NonNullJsonCompatible<T> = Exclude<JsonCompatible<T>, null | undefined>;

class OpenCloudWorkQueueWriter<T> implements WorkQueueHost<T> {
	private readonly encode: (item: T) => QueueData;
	private readonly queueId: string;
	private readonly storage: StorageClient;
	private readonly universeId: string;

	constructor(options: WorkQueueWriterOptions<T>) {
		this.encode = options.encode;
		this.queueId = options.queueId;
		this.storage = createStorageClient(options);
		this.universeId = options.universeId;
	}

	public async acknowledgeAsync(receipt: string): Promise<void> {
		const result = await this.storage.queues.discard({
			queueId: this.queueId,
			readId: receipt,
			universeId: this.universeId,
		});
		if (!result.success) {
			throw new Error(`Failed to acknowledge work batch: ${result.err.message}`);
		}
	}

	public async enqueueAsync(
		items: ReadonlyArray<T>,
		options: { readonly ttlMs?: number } = {},
	): Promise<void> {
		const ttl = options.ttlMs !== undefined ? msToSecondsCeil(options.ttlMs) : undefined;
		for (const item of items) {
			let parameters: EnqueueQueueItemParameters = {
				data: this.encode(item),
				queueId: this.queueId,
				universeId: this.universeId,
			};
			if (ttl !== undefined) {
				parameters = { ...parameters, ttl };
			}

			const result = await this.storage.queues.enqueue(parameters);
			if (!result.success) {
				throw new Error(`Failed to enqueue work item: ${result.err.message}`);
			}
		}
	}
}

/**
 * Create a producer for values already compatible with JSON.
 * @param options - Queue identity, transport and JSON payload lifetime.
 * @returns Queue writer retaining JSON payloads without a custom encoder.
 * @template T
 */
export function createJsonWorkQueueWriter<T>(
	options: JsonWorkQueueWriterOptions,
): WorkQueueWriter<NonNullJsonCompatible<T>> {
	return new OpenCloudWorkQueueWriter({ ...options, encode: (item) => item });
}

/**
 * Create a producer that can acknowledge opaque worker receipts.
 * @param options - Queue identity, transport and payload encoder.
 * @returns Queue producer with opaque worker-receipt acknowledgement.
 * @template T
 */
export function createWorkQueueHost<T>(options: WorkQueueWriterOptions<T>): WorkQueueHost<T> {
	return new OpenCloudWorkQueueWriter(options);
}

/**
 * Create a producer using the supplied encoder.
 * @param options - Queue identity, transport and payload encoder.
 * @returns Queue writer using the supplied encoder.
 * @template T
 */
export function createWorkQueueWriter<T>(options: WorkQueueWriterOptions<T>): WorkQueueWriter<T> {
	return new OpenCloudWorkQueueWriter(options);
}
