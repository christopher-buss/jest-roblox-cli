import type { StreamingResultEntry } from "../memory-store/sorted-map-client.ts";

export type StreamingAggregatorOnEntry = (entry: StreamingResultEntry) => void;

export interface StreamingAggregatorOptions {
	/**
	 * Called once per newly-accepted entry, in arrival order. Streaming
	 * formatters (e.g. the human formatter) use this hook to write per-package
	 * output to stdout as results land. Buffering formatters (e.g. JSON) omit
	 * the hook and collect everything via {@link StreamingAggregator.drain}
	 * at task end.
	 */
	onEntry?: StreamingAggregatorOnEntry;
}

/**
 * Reduces a stream of per-package result events into:
 *
 * 1. A list of accepted entries in arrival order, returned by `drain()`,
 *    for callers that need to inspect what arrived live (e.g. to emit a
 *    final per-formatter summary).
 * 2. An optional per-entry hook for streaming formatters to flush partial
 *    output as packages complete.
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

	constructor(options: StreamingAggregatorOptions = {}) {
		this.onEntry = options.onEntry;
	}

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

	public drain(): Array<StreamingResultEntry> {
		return [...this.entries];
	}
}
