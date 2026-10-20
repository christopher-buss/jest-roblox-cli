import type {
	HttpClient,
	OpenCloudClientOptions,
	OpenCloudError,
	Result,
	SleepFunc,
} from "@bedrock-rbx/ocale";
import type { ListSortedMapItemsParameters } from "@bedrock-rbx/ocale/storage";
import { StorageClient } from "@bedrock-rbx/ocale/storage";

export interface SortedMapInboxOptions<T> {
	readonly apiKey: string;
	readonly baseUrl?: string;
	readonly decode: (value: JSONValue) => T;
	readonly httpClient?: HttpClient;
	readonly mapId: string;
	readonly sleep?: SleepFunc;
	readonly universeId: string;
}

export interface SortedMapEntry<T> {
	readonly id: string;
	readonly value: T;
}

/** Page size for the list sweep; the server caps it at 100. */
const PAGE_SIZE = 100;

/**
 * Host side of a MemoryStore SortedMap the Luau tasks write: list every entry
 * with its key, and delete the ones consumed. Injectable (fake `httpClient`)
 * for tests.
 */
export class SortedMapInbox<T> {
	private readonly decode: (value: JSONValue) => T;
	private readonly mapId: string;
	private readonly storage: StorageClient;
	private readonly universeId: string;

	constructor(options: SortedMapInboxOptions<T>) {
		this.decode = options.decode;
		this.mapId = options.mapId;
		this.universeId = options.universeId;
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

		this.storage = new StorageClient(clientOptions);
	}

	public async deleteAsync(itemId: string): Promise<Result<undefined, OpenCloudError>> {
		const deleted = await this.storage.sortedMaps.delete({
			itemId,
			mapId: this.mapId,
			universeId: this.universeId,
		});
		return deleted.success ? { data: undefined, success: true } : deleted;
	}

	/**
	 * List every entry and decode its value. Pages through the list until the
	 * server stops returning a continuation token.
	 */
	public async readAllAsync(): Promise<Result<Array<SortedMapEntry<T>>, OpenCloudError>> {
		const entries: Array<SortedMapEntry<T>> = [];
		let pageToken: string | undefined;

		do {
			let parameters: ListSortedMapItemsParameters = {
				mapId: this.mapId,
				maxPageSize: PAGE_SIZE,
				universeId: this.universeId,
			};
			if (pageToken !== undefined) {
				parameters = { ...parameters, pageToken };
			}

			const result = await this.storage.sortedMaps.list(parameters);
			if (!result.success) {
				return result;
			}

			for (const item of result.data.items) {
				entries.push({ id: item.id, value: this.decode(item.value) });
			}

			pageToken = result.data.nextPageToken;
		} while (pageToken !== undefined);

		return { data: entries, success: true };
	}
}
