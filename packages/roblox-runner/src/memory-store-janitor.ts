import type { SleepFunc } from "@bedrock-rbx/ocale";
import type { StorageClient } from "@bedrock-rbx/ocale/storage";

import { setTimeout as delay } from "node:timers/promises";

import type { OpenCloudConnection } from "./client-options.ts";
import { createStorageClient } from "./client-options.ts";
import { dequeueOrEmptyAsync } from "./work-queue-shared.ts";

/**
 * Run-owned storage and bounded claim-recovery policy.
 */
export interface MemoryStoreJanitorOptions extends OpenCloudConnection {
	/**
	 * How long an item stays invisible to a dequeue once a consumer claims it,
	 * in seconds. The reclaim pass outwaits it; the caller owns the figure,
	 * because it is the same one the consumer claims with.
	 */
	readonly claimWindowSeconds: number;
	/** Receives one line per swallowed failure. Omitted ⇒ silent. */
	readonly log?: ((message: string) => void) | undefined;
	/** Every SortedMap the run's tasks write; each key in each is deleted. */
	readonly mapIds: ReadonlyArray<string>;
	/** The run's own work queue id. */
	readonly queueId: string;
	/**
	 * Ceiling on the reclaim pass's wait, in seconds. What a claim window is
	 * worth in held-open time is the caller's policy, not the janitor's. The
	 * janitor only reports the shortfall when the cap bites.
	 */
	readonly reclaimBudgetSeconds: number;
	/** Paces the retry backoff and the reclaim wait (injected for tests). */
	readonly sleep?: SleepFunc;
}

const PAGE_SIZE = 100;
const DISCARD_CLAIM_SECONDS = 1;
const MAX_DRAIN_SWEEPS = 50;

/**
 * Best-effort cleanup after a run has stopped producing work, bound to one
 * run's queue and maps.
 */
export class MemoryStoreJanitor {
	private readonly claimWindowSeconds: number;
	private readonly log: ((message: string) => void) | undefined;
	private readonly mapIds: ReadonlyArray<string>;
	private readonly queueId: string;
	private readonly reclaimBudgetSeconds: number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly storage: StorageClient;
	private readonly universeId: string;

	constructor(options: MemoryStoreJanitorOptions) {
		this.claimWindowSeconds = options.claimWindowSeconds;
		this.log = options.log;
		this.mapIds = options.mapIds;
		this.queueId = options.queueId;
		this.reclaimBudgetSeconds = options.reclaimBudgetSeconds;
		this.sleep = options.sleep ?? delay;
		// A caller's sleep reaches both the retry backoff and the reclaim
		// wait, so one fake clock drives the two timers.
		this.storage = createStorageClient(options);
		this.universeId = options.universeId;
	}

	/**
	 * Best-effort cleanup of the run's own MemoryStore litter; never rejects.
	 */
	public async cleanupAsync(): Promise<void> {
		await this.drainQueueAsync();
		for (const mapId of this.mapIds) {
			await this.deleteMapKeysAsync(mapId);
		}
	}

	/**
	 * Outwait the claim window, then clean again: the pass that reaches items
	 * a live consumer held when the run ended. Never rejects.
	 */
	public async reclaimClaimedAsync(): Promise<void> {
		const waitSeconds = Math.min(this.claimWindowSeconds, this.reclaimBudgetSeconds);
		const tail =
			waitSeconds < this.claimWindowSeconds
				? ` of the ${this.claimWindowSeconds}s claim window. Only items with ${waitSeconds}s or less left on their claim resurface; the rest expire with the queue TTL`
				: " for claimed items to resurface";
		this.log?.(`memory-store teardown: waiting ${waitSeconds}s${tail}`);
		await this.sleep(waitSeconds * 1000);
		await this.cleanupAsync();
	}

	private async deleteMapKeysAsync(mapId: string): Promise<void> {
		const itemIds = await this.listMapKeyIdsAsync(mapId);
		for (const itemId of itemIds) {
			const deleted = await this.storage.sortedMaps.delete({
				itemId,
				mapId,
				universeId: this.universeId,
			});
			if (!deleted.success) {
				this.log?.(
					`memory-store teardown: ${mapId} key delete failed: ${deleted.err.message}`,
				);
			}
		}
	}

	private async drainQueueAsync(): Promise<void> {
		for (let sweep = 0; sweep < MAX_DRAIN_SWEEPS; sweep += 1) {
			const hasMore = await this.sweepQueueOnceAsync();
			if (!hasMore) {
				return;
			}
		}

		this.log?.(
			"memory-store teardown: drain sweep cap reached. Remaining items expire with the queue TTL",
		);
	}

	private async listMapKeyIdsAsync(mapId: string): Promise<Array<string>> {
		const itemIds: Array<string> = [];
		let pageToken: string | undefined;

		do {
			const page = await this.storage.sortedMaps.list({
				mapId,
				maxPageSize: PAGE_SIZE,
				universeId: this.universeId,
				...(pageToken === undefined ? {} : { pageToken }),
			});
			if (!page.success) {
				this.log?.(`memory-store teardown: ${mapId} list failed: ${page.err.message}`);
				return itemIds;
			}

			for (const item of page.data.items) {
				itemIds.push(item.id);
			}

			pageToken = page.data.nextPageToken;
		} while (pageToken !== undefined);

		return itemIds;
	}

	private async sweepQueueOnceAsync(): Promise<boolean> {
		const read = await dequeueOrEmptyAsync(this.storage, {
			count: PAGE_SIZE,
			invisibilityWindow: DISCARD_CLAIM_SECONDS,
			queueId: this.queueId,
			universeId: this.universeId,
		});
		if (!read.success) {
			this.log?.(
				`memory-store teardown: queue drain failed: ${read.err.message}. Leftovers expire with the queue TTL`,
			);
			return false;
		}

		if (read.data.readId === undefined) {
			return false;
		}

		const discarded = await this.storage.queues.discard({
			queueId: this.queueId,
			readId: read.data.readId,
			universeId: this.universeId,
		});
		if (!discarded.success) {
			this.log?.(
				`memory-store teardown: queue discard failed: ${discarded.err.message}. Leftovers expire with the queue TTL`,
			);
			return false;
		}

		return true;
	}
}
