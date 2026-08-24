import type { HttpClient, SleepFunc } from "@bedrock-rbx/ocale";
import type { StorageClient } from "@bedrock-rbx/ocale/storage";

import { createWorkQueueStorage } from "./work-queue-shared.ts";

export interface MemoryStoreJanitorOptions {
	readonly apiKey: string;
	readonly baseUrl?: string | undefined;
	readonly httpClient?: HttpClient;
	/** Receives one line per swallowed failure. Omitted ⇒ silent. */
	readonly log?: ((message: string) => void) | undefined;
	/** The run's progress SortedMap id. */
	readonly mapId: string;
	/** The run's own work queue id. */
	readonly queueId: string;
	readonly sleep?: SleepFunc;
	readonly universeId: string;
}

export interface MemoryStoreJanitor {
	/**
	 * Best-effort cleanup of the run's own MemoryStore litter; never rejects.
	 */
	cleanupAsync(): Promise<void>;
}

/** Server cap on items per dequeue and per list page. */
const PAGE_SIZE = 100;
/**
 * A failed discard must not hide leftovers from a retry for the default 30s
 * window — the janitor never processes what it claims, so the shortest window
 * the server accepts is the right one.
 */
const CLAIM_WINDOW_SECONDS = 1;
/**
 * Termination guarantee for the drain loop: a leftover backlog is finite (the
 * streaming budget bounds it well under one page), so hitting this cap means
 * something else is filling the queue — stop and let the TTL take it.
 */
const MAX_DRAIN_SWEEPS = 50;

/**
 * Best-effort teardown for the two MemoryStore structures a cancelled run
 * leaves behind: its work queue and its progress SortedMap. Bound to one
 * `queueId`/`mapId` at construction, so it structurally cannot touch a
 * concurrent sibling run's data — and it never issues the universe-wide
 * `memory-store:flush`. Every failure is logged and swallowed: leftovers the
 * janitor cannot reach (claimed-invisible items, a mid-drain API error) expire
 * with the queue TTL backstop.
 */
class OpenCloudMemoryStoreJanitor implements MemoryStoreJanitor {
	private readonly log: ((message: string) => void) | undefined;
	private readonly mapId: string;
	private readonly queueId: string;
	private readonly storage: StorageClient;
	private readonly universeId: string;

	constructor(options: MemoryStoreJanitorOptions) {
		this.log = options.log;
		this.mapId = options.mapId;
		this.queueId = options.queueId;
		this.storage = createWorkQueueStorage(options);
		this.universeId = options.universeId;
	}

	public async cleanupAsync(): Promise<void> {
		await this.drainQueueAsync();
		await this.deleteProgressKeysAsync();
	}

	/**
	 * Delete every progress key the list surfaces. An individual delete
	 * failure skips to the next key — the survivors self-expire.
	 */
	private async deleteProgressKeysAsync(): Promise<void> {
		const itemIds = await this.listProgressKeyIdsAsync();
		for (const itemId of itemIds) {
			const deleted = await this.storage.sortedMaps.delete({
				itemId,
				mapId: this.mapId,
				universeId: this.universeId,
			});
			if (!deleted.success) {
				this.log?.(
					`memory-store teardown: progress key delete failed: ${deleted.err.message}`,
				);
			}
		}
	}

	/**
	 * Dequeue→discard sweeps until an empty read. Items currently invisible
	 * (claimed by a dead task, window not yet elapsed) are not returned and are
	 * left to the TTL. A clean completion costs exactly one empty dequeue.
	 */
	private async drainQueueAsync(): Promise<void> {
		for (let sweep = 0; sweep < MAX_DRAIN_SWEEPS; sweep += 1) {
			const hasMore = await this.sweepQueueOnceAsync();
			if (!hasMore) {
				return;
			}
		}

		this.log?.(
			"memory-store teardown: drain sweep cap reached — remaining items expire with the queue TTL",
		);
	}

	/**
	 * Page through the progress map collecting key ids. A list failure
	 * abandons the unseen pages (their keys self-expire).
	 */
	private async listProgressKeyIdsAsync(): Promise<Array<string>> {
		const itemIds: Array<string> = [];
		let pageToken: string | undefined;

		do {
			const page = await this.storage.sortedMaps.list({
				mapId: this.mapId,
				maxPageSize: PAGE_SIZE,
				universeId: this.universeId,
				...(pageToken === undefined ? {} : { pageToken }),
			});
			if (!page.success) {
				this.log?.(`memory-store teardown: progress list failed: ${page.err.message}`);
				return itemIds;
			}

			for (const item of page.data.items) {
				itemIds.push(item.id);
			}

			pageToken = page.data.nextPageToken;
		} while (pageToken !== undefined);

		return itemIds;
	}

	/** One dequeue→discard sweep; `true` while more items may remain. */
	private async sweepQueueOnceAsync(): Promise<boolean> {
		const read = await this.storage.queues.dequeue({
			count: PAGE_SIZE,
			invisibilityWindow: CLAIM_WINDOW_SECONDS,
			queueId: this.queueId,
			universeId: this.universeId,
		});
		if (!read.success) {
			this.log?.(
				`memory-store teardown: queue drain failed: ${read.err.message} — leftovers expire with the queue TTL`,
			);
			return false;
		}

		if (read.data.items.length === 0) {
			return false;
		}

		const discarded = await this.storage.queues.discard({
			queueId: this.queueId,
			readId: read.data.readId,
			universeId: this.universeId,
		});
		if (!discarded.success) {
			this.log?.(
				`memory-store teardown: queue discard failed: ${discarded.err.message} — leftovers expire with the queue TTL`,
			);
			return false;
		}

		return true;
	}
}

export function createMemoryStoreJanitor(options: MemoryStoreJanitorOptions): MemoryStoreJanitor {
	return new OpenCloudMemoryStoreJanitor(options);
}
