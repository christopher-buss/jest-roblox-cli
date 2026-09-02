import type { HttpClient, SleepFunc } from "@bedrock-rbx/ocale";
import type { StorageClient } from "@bedrock-rbx/ocale/storage";

import { setTimeout as delay } from "node:timers/promises";

import { createWorkQueueStorage } from "./work-queue-shared.ts";

export interface MemoryStoreJanitorOptions {
	readonly apiKey: string;
	readonly baseUrl?: string | undefined;
	/**
	 * How long an item stays invisible to a dequeue once a consumer claims it,
	 * in seconds. The reclaim pass outwaits it; the caller owns the figure,
	 * because it is the same one the consumer claims with.
	 */
	readonly claimWindowSeconds: number;
	readonly httpClient?: HttpClient;
	/** Receives one line per swallowed failure. Omitted ⇒ silent. */
	readonly log?: ((message: string) => void) | undefined;
	/** The run's progress SortedMap id. */
	readonly mapId: string;
	/** The run's own work queue id. */
	readonly queueId: string;
	/**
	 * Ceiling on the reclaim pass's wait, in seconds. What a claim window is
	 * worth in held-open time is the caller's policy, not the janitor's — the
	 * janitor only reports the shortfall when the cap bites.
	 */
	readonly reclaimBudgetSeconds: number;
	/** Paces the retry backoff and the reclaim wait (injected for tests). */
	readonly sleep?: SleepFunc;
	readonly universeId: string;
}

export interface MemoryStoreJanitor {
	/**
	 * Best-effort cleanup of the run's own MemoryStore litter; never rejects.
	 */
	cleanupAsync(): Promise<void>;
	/**
	 * Outwait the claim window, then clean again — the pass that reaches items
	 * a live consumer held when the run ended. Never rejects.
	 */
	reclaimClaimedAsync(): Promise<void>;
}

/** Server cap on items per dequeue and per list page. */
const PAGE_SIZE = 100;
/**
 * A failed discard must not hide leftovers from a retry for the default 30s
 * window — the janitor never processes what it claims, so the shortest window
 * the server accepts is the right one.
 */
const DISCARD_CLAIM_SECONDS = 1;
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
 * janitor cannot reach (a mid-drain API error, a claim that outlives the
 * caller's reclaim budget) expire with the queue TTL backstop.
 */
class OpenCloudMemoryStoreJanitor implements MemoryStoreJanitor {
	private readonly claimWindowSeconds: number;
	private readonly log: ((message: string) => void) | undefined;
	private readonly mapId: string;
	private readonly queueId: string;
	private readonly reclaimBudgetSeconds: number;
	private readonly sleep: SleepFunc;
	private readonly storage: StorageClient;
	private readonly universeId: string;

	constructor(options: MemoryStoreJanitorOptions) {
		this.claimWindowSeconds = options.claimWindowSeconds;
		this.log = options.log;
		this.mapId = options.mapId;
		this.queueId = options.queueId;
		this.reclaimBudgetSeconds = options.reclaimBudgetSeconds;
		this.sleep = options.sleep ?? delay;
		// Resolved once, so the retry backoff and the reclaim wait can never
		// drift onto two different timers.
		this.storage = createWorkQueueStorage({ ...options, sleep: this.sleep });
		this.universeId = options.universeId;
	}

	public async cleanupAsync(): Promise<void> {
		await this.drainQueueAsync();
		await this.deleteProgressKeysAsync();
	}

	/**
	 * A dequeue returns visible items only, so an item a live consumer held
	 * when the run ended is structurally unreachable until its claim elapses.
	 * Wait that window out, then clean again.
	 *
	 * The caller's budget caps the wait, and a capped wait is a wait rather
	 * than an age filter: sleeping `B` exposes only the claims with `B` or less
	 * left to run — those already older than `window - B`. A claim taken long
	 * before the run ended can still have most of its window ahead of it, so a
	 * cap well under the window reclaims little. The log line says which case
	 * this run is in.
	 *
	 * Cleans rather than merely drains: a consumer starved mid-run stays alive
	 * until its next claim and rewrites its progress key during the wait.
	 */
	public async reclaimClaimedAsync(): Promise<void> {
		const waitSeconds = Math.min(this.claimWindowSeconds, this.reclaimBudgetSeconds);
		const tail =
			waitSeconds < this.claimWindowSeconds
				? ` of the ${this.claimWindowSeconds}s claim window — only items with ${waitSeconds}s or less left on their claim resurface; the rest expire with the queue TTL`
				: " for claimed items to resurface";
		this.log?.(`memory-store teardown: waiting ${waitSeconds}s${tail}`);
		await this.sleep(waitSeconds * 1000);
		await this.cleanupAsync();
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
			invisibilityWindow: DISCARD_CLAIM_SECONDS,
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
