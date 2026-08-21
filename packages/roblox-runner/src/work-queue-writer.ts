import type { HttpClient, SleepFunc } from "@bedrock-rbx/ocale";
import type { EnqueueQueueItemParameters, StorageClient } from "@bedrock-rbx/ocale/storage";

import type { QueueData } from "./work-queue-shared.ts";
import { createWorkQueueStorage, msToSecondsCeil } from "./work-queue-shared.ts";

export interface WorkQueueWriterOptions<T> {
	readonly apiKey: string;
	readonly baseUrl?: string | undefined;
	readonly encode: (item: T) => QueueData;
	readonly httpClient?: HttpClient;
	readonly queueId: string;
	readonly sleep?: SleepFunc;
	readonly universeId: string;
}

export interface JsonWorkQueueWriterOptions {
	readonly apiKey: string;
	readonly baseUrl?: string | undefined;
	readonly httpClient?: HttpClient;
	readonly queueId: string;
	readonly sleep?: SleepFunc;
	readonly universeId: string;
}

export interface WorkQueueWriter<T> {
	enqueueAsync(items: ReadonlyArray<T>, options?: { readonly ttlMs?: number }): Promise<void>;
}

type JsonCompatible<T> = T extends boolean | null | number | string
	? T
	: T extends (...arguments_: Array<never>) => void
		? never
		: T extends object
			? { [Key in keyof T]: JsonCompatible<T[Key]> }
			: never;

type NonNullJsonCompatible<T> = Exclude<JsonCompatible<T>, null | undefined>;

class OpenCloudWorkQueueWriter<T> implements WorkQueueWriter<T> {
	private readonly encode: (item: T) => QueueData;
	private readonly queueId: string;
	private readonly storage: StorageClient;
	private readonly universeId: string;

	constructor(options: WorkQueueWriterOptions<T>) {
		this.encode = options.encode;
		this.queueId = options.queueId;
		this.storage = createWorkQueueStorage(options);
		this.universeId = options.universeId;
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

export function createJsonWorkQueueWriter<T>(
	options: JsonWorkQueueWriterOptions,
): WorkQueueWriter<NonNullJsonCompatible<T>> {
	return new OpenCloudWorkQueueWriter({ ...options, encode: (item) => item });
}

export function createWorkQueueWriter<T>(options: WorkQueueWriterOptions<T>): WorkQueueWriter<T> {
	return new OpenCloudWorkQueueWriter(options);
}
