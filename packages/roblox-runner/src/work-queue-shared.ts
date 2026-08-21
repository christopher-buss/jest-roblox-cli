import type { HttpClient, OpenCloudClientOptions, SleepFunc } from "@bedrock-rbx/ocale";
import type { EnqueueQueueItemParameters } from "@bedrock-rbx/ocale/storage";
import { StorageClient } from "@bedrock-rbx/ocale/storage";

export type QueueData = EnqueueQueueItemParameters["data"];

interface WorkQueueStorageOptions {
	readonly apiKey: string;
	readonly baseUrl?: string | undefined;
	readonly httpClient?: HttpClient;
	readonly sleep?: SleepFunc;
}

export function createWorkQueueStorage(options: WorkQueueStorageOptions): StorageClient {
	let clientOptions: OpenCloudClientOptions = { apiKey: options.apiKey };
	if (options.baseUrl !== undefined) {
		clientOptions = { ...clientOptions, baseUrl: options.baseUrl };
	}

	if (options.httpClient !== undefined) {
		clientOptions = { ...clientOptions, httpClient: options.httpClient };
	}

	if (options.sleep !== undefined) {
		clientOptions = { ...clientOptions, sleep: options.sleep };
	}

	return new StorageClient(clientOptions);
}

export function msToSecondsCeil(ms: number): number {
	return Math.max(1, Math.ceil(ms / 1000));
}
