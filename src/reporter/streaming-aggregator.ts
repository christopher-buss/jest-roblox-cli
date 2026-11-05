import type { StreamingResultEntry } from "../memory-store/sorted-map-client.ts";

/** Hook called with each newly accepted entry. */
export type StreamingAggregatorOnEntry = (entry: StreamingResultEntry) => void;

/** Options of {@link StreamingAggregator}. */
export interface StreamingAggregatorOptions {
	/**
	 * Called once per newly-accepted entry, in arrival order. Streaming
	 * formatters, such as the human one, use this hook to write per-package
	 * output to stdout as results land. Buffering formatters, such as JSON,
	 * omit the hook and collect everything at task end via
	 * {@link StreamingAggregator.drain}.
	 */
	onEntry?: StreamingAggregatorOnEntry;
}

/**
 * Reduces a stream of per-package result events into two outputs. The
 * first is a list of accepted entries in arrival order, returned by `drain()`,
 * for callers that need to inspect what arrived live, such as to emit a final
 * per-formatter summary. The second is an optional per-entry hook for
 * streaming formatters to flush partial output as packages complete.
 *
 * Duplicate entries (same `pkg::project` key) are dropped — work-stealing
 * fault recovery can republish a package after its invisibility window
 * elapses; first arrival wins.
 *
 * The aggregator does NOT persist per-package output files; full Jest
 * results land via the task's final envelope and are written from
 * `workspace-runner` against that authoritative data. SortedMap items
 * are capped at 32 KB, so streaming carries only summary counts.
 */
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
		const key = `${entry.pkg}::${entry.project}`;
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
