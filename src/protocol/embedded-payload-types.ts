/**
 * One staged package run, as `luau/staging/embedded-runner.luau` decodes it.
 *
 * @template Argv - The Jest argv the entry runs with.
 */
export interface EmbeddedEntry<Argv> {
	/** Jest argv of the run. */
	config: Argv;
	/** Staged package the materializer materializes. */
	pkg: string;
	/** Project display name the result is reported under. */
	project: string;
}

/** One work-stealing queue item: the entry it names. */
export type WorkQueueItem = Pick<EmbeddedEntry<unknown>, "pkg" | "project">;

/**
 * The payload `luau/staging/embedded-runner.luau` decodes, whichever producer
 * builds it: the Open Cloud task script or the Studio plugin's run payload.
 *
 * @template Argv - The Jest argv each entry runs with.
 */
export interface EmbeddedPayload<Argv> {
	/** Stop taking packages once one fails. */
	bail?: boolean | undefined;
	/** SortedMap the parallel wave broadcasts a bail through. */
	bailMapId?: string;
	/** Package runs, in order. */
	entries: Array<EmbeddedEntry<Argv>>;
	/** Work-stealing invisibility window, in seconds. */
	invisibilityWindowSeconds?: number;
	/** Work-stealing queue to pop entries from. */
	queueId?: string;
	/** TTL the queue items were seeded with, in seconds. */
	queueTtlSeconds?: number | undefined;
	/** Cap on the encoded size of the task's return envelope, in bytes. */
	resultBudgetBytes?: number | undefined;
	/** How long the caller waits for the whole run, in milliseconds. */
	runBudgetMs?: number;
	/** SortedMap each package result is streamed to. */
	sortedMapId?: string;
	/** TTL of each streamed result, in seconds. */
	streamingTtlSeconds?: number | undefined;
	/** How many Luau VMs one package's projects split across. */
	vmParallel?: number;
}
