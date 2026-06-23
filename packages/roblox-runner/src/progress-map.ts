import type { HttpClient, SleepFunc } from "@bedrock-rbx/ocale";
import { StorageClient } from "@bedrock-rbx/ocale/storage";

export interface ProgressMapOptions<T> {
	readonly apiKey: string;
	readonly baseUrl?: string;
	readonly decode: (value: unknown) => T;
	readonly httpClient?: HttpClient;
	readonly mapId: string;
	readonly sleep?: SleepFunc;
	readonly universeId: string;
}

/** Page size for the list sweep; the server caps it at 100. */
const PAGE_SIZE = 100;

/**
 * Read-only view over a MemoryStore SortedMap used as an approximate progress
 * channel: each in-flight task overwrites one key named after itself with its
 * running tally, and {@link ProgressMap.readAll} sweeps every key for the
 * Node-side aggregator. The map is never written from Node — the Luau tasks own
 * the writes — so this is the read counterpart to the work queue, kept minimal
 * and injectable (fake `httpClient`) for tests.
 */
export class ProgressMap<T> {
	private readonly decode: (value: unknown) => T;
	private readonly mapId: string;
	private readonly storage: StorageClient;
	private readonly universeId: string;

	constructor(options: ProgressMapOptions<T>) {
		this.decode = options.decode;
		this.mapId = options.mapId;
		this.universeId = options.universeId;
		this.storage = new StorageClient({
			apiKey: options.apiKey,
			...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
			...(options.httpClient !== undefined ? { httpClient: options.httpClient } : {}),
			...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
		});
	}

	/**
	 * List every counter key and decode its value. Pages through the list until
	 * the server stops returning a continuation token, so a run spreading work
	 * across more keys than one page holds is still read whole.
	 */
	public async readAll(): Promise<Array<T>> {
		const values: Array<T> = [];
		let pageToken: string | undefined;

		do {
			const result = await this.storage.sortedMaps.list({
				mapId: this.mapId,
				maxPageSize: PAGE_SIZE,
				universeId: this.universeId,
				...(pageToken !== undefined ? { pageToken } : {}),
			});
			if (!result.success) {
				throw new Error(`Failed to read progress map: ${result.err.message}`);
			}

			for (const item of result.data.items) {
				values.push(this.decode(item.value));
			}

			pageToken = result.data.nextPageToken;
		} while (pageToken !== undefined);

		return values;
	}
}
