import { SortedMapInbox, type SortedMapInboxOptions } from "./sorted-map-inbox.ts";

export type ProgressMapOptions<T> = SortedMapInboxOptions<T>;

/**
 * Read-only view over a MemoryStore SortedMap used as an approximate progress
 * channel: each in-flight task overwrites one key named after itself with its
 * running tally, and {@link ProgressMap.readAllAsync} sweeps every key for the
 * Node-side aggregator. The map is never written from Node — the Luau tasks own
 * the writes — so this is the read counterpart to the work queue, kept minimal
 * and injectable (fake `httpClient`) for tests.
 */
export class ProgressMap<T> {
	private readonly inbox: SortedMapInbox<T>;
	private readonly mapId: string;

	constructor(options: ProgressMapOptions<T>) {
		this.inbox = new SortedMapInbox(options);
		this.mapId = options.mapId;
	}

	/**
	 * List every counter key and decode its value. Pages through the list until
	 * the server stops returning a continuation token, so a run spreading work
	 * across more keys than one page holds is still read whole.
	 */
	public async readAllAsync(): Promise<Array<T>> {
		const read = await this.inbox.readAllAsync();
		if (!read.success) {
			throw new Error(`Failed to read sorted map ${this.mapId}: ${read.err.message}`);
		}

		return read.data.map(({ value }) => value);
	}
}
