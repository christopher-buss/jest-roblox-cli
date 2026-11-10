import { entryKey } from "../protocol/envelope.ts";
import type { StreamingResultEntry } from "../protocol/streaming-summary.ts";

/** Hook called with each newly accepted entry. */
export type StreamingAggregatorOnEntry = (entry: StreamingResultEntry) => void;

/** Options of {@link StreamingAggregator}. */
export interface StreamingAggregatorOptions {
	/** Called once per newly accepted entry, in arrival order. */
	onEntry?: StreamingAggregatorOnEntry;
}

/** Reduces per-package result events; the first `pkg::project` arrival wins. */
export class StreamingAggregator {
	private readonly entries: Array<StreamingResultEntry> = [];
	private readonly onEntry: StreamingAggregatorOnEntry | undefined;
	private readonly seen = new Set<string>();

	/**
	 * Bind the optional per-entry hook.
	 *
	 * @param options - Carries the optional `onEntry` hook.
	 */
	constructor(options: StreamingAggregatorOptions = {}) {
		this.onEntry = options.onEntry;
	}

	/**
	 * Record an entry unless its `pkg::project` key already arrived.
	 *
	 * @param entry - Streamed result entry.
	 * @returns `true` when the entry is new, `false` for a duplicate.
	 */
	public accept(entry: StreamingResultEntry): boolean {
		const key = entryKey(entry.pkg, entry.project);
		if (this.seen.has(key)) {
			return false;
		}

		this.seen.add(key);
		this.entries.push(entry);
		this.onEntry?.(entry);
		return true;
	}

	/**
	 * Copy of the accepted entries in arrival order.
	 *
	 * @returns The accepted entries.
	 */
	public drain(): Array<StreamingResultEntry> {
		return [...this.entries];
	}
}
