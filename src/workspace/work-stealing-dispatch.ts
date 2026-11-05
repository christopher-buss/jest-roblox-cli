import process from "node:process";

import type { StreamingHooks } from "../backends/interface.ts";
import type { RunProjectsOptions } from "../executor.ts";
import { StreamingResultClient } from "../memory-store/sorted-map-client.ts";
import type {
	PreparedWorkStealing,
	prepareWorkStealingQueueAsync,
} from "../memory-store/work-stealing.ts";
import {
	StreamingAggregator,
	type StreamingAggregatorOnEntry,
} from "../reporter/streaming-aggregator.ts";
import {
	generateWorkStealingScript,
	type MaterializerInput,
} from "../staging/test-script-staged.ts";
import { errorMessage } from "../utils/error-message.ts";

/** Open Cloud access for the work-stealing queue and result map. */
export interface WorkStealingCredentials {
	/** Open Cloud API key with MemoryStore access. */
	apiKey: string;
	/** Override the Open Cloud base URL. */
	baseUrl?: string | undefined;
	/** Universe that owns the queue and the map. */
	universeId: string;
}

/** Inputs to set up a work-stealing dispatch. */
export interface WorkStealingDispatchInput {
	/** Whether to stop on the first failing package. */
	bail: boolean;
	/** Open Cloud access for the queue and the map. */
	credentials: WorkStealingCredentials;
	/** ID generator for the result map. */
	generateUuid: () => string;
	/** One materializer input per job. */
	inputs: Array<MaterializerInput>;
	/** Receives each streamed package result, if set. */
	onStreamingResult?: StreamingAggregatorOnEntry | undefined;
	/** Task count, or `"auto"` to let the backend choose. */
	parallel: "auto" | number;
	/** Queue preparation, injectable for tests. */
	prepareWorkStealingQueue: typeof prepareWorkStealingQueueAsync;
}

type StealingDispatchSpec = Pick<
	RunProjectsOptions,
	"parallel" | "scriptOverride" | "streaming" | "workStealing"
>;

interface BuildStreamingResult {
	hooks: StreamingHooks;
	sortedMapId: string;
}

/**
 * Build the work-stealing spec, or report `undefined` when the queue could not
 * be set up.
 *
 * The queue needs `memory-store.queue:*` on the API key, which the scopes for
 * an ordinary run do not include — so a key that has always worked starts
 * failing the moment `"auto"` begins to shard. A run that still produces
 * correct results is a better answer than a hard failure, so degrade and say
 * why: any queue error lands here, because whatever went wrong (missing scope,
 * network, quota) static bucketing is still available and still right. What
 * the run gives up is rebalancing, not concurrency — the shard count carries
 * over, so a bucket that finishes early idles instead of stealing.
 * @param input - Credentials, materializer inputs and queue seams.
 * @returns The dispatch spec, or `undefined` when the queue setup failed.
 */
export async function tryStealingDispatchAsync(
	input: WorkStealingDispatchInput,
): Promise<StealingDispatchSpec | undefined> {
	try {
		return await prepareStealingDispatchAsync(input);
	} catch (err) {
		process.stderr.write(
			"Warning: could not set up the work-stealing queue, running packages " +
				`with no work-stealing: ${errorMessage(err)}\n` +
				"Grant the API key memory-store.queue:add/dequeue/discard so tasks " +
				"can rebalance instead of running a fixed share each.\n",
		);
		return undefined;
	}
}

/**
 * The longest any one package in the batch may run, in the seconds the queue
 * measures its invisibility window in.
 *
 * A package with no budget of its own is bounded only by the deadline Roblox
 * gives the whole task, so that is what a sibling has to wait out before
 * reclaiming its queue item. Taking the slowest is what keeps a fast package
 * from setting the window for a slow one: reclaiming an item still being
 * worked on runs it twice.
 *
 * That deadline is the first job's `timeout` for every package in the batch,
 * not each package's own — the backend resolves one run timeout from `jobs[0]`
 * and gives every work-stealing task the same one. Reading a later package's
 * `timeout` instead sizes the window under the deadline its item is actually
 * worked on under, which is the double-run this window exists to prevent. It
 * bounds an explicit budget for the same reason: Roblox ends the task first, so
 * waiting past it only delays reclaiming an item whose worker is already gone.
 * @param inputs - Materializer inputs of the batch.
 * @returns The window, in whole seconds.
 */
function longestPackageSeconds(inputs: ReadonlyArray<MaterializerInput>): number {
	let longestMs = 0;
	for (const { config } of inputs) {
		// Read here rather than above the loop because this is where the batch
		// is known to have a first entry: an empty one never reaches the body,
		// and answers with the zero below rather than with a deadline.
		// oxlint-disable-next-line typescript/no-non-null-assertion -- non-empty inside its own loop
		const taskDeadlineMs = inputs[0]!.config.timeout;
		longestMs = Math.max(
			longestMs,
			config.projectTimeout > 0
				? Math.min(config.projectTimeout, taskDeadlineMs)
				: taskDeadlineMs,
		);
	}

	return Math.ceil(longestMs / 1000);
}

function buildStreaming(input: {
	credentials: WorkStealingCredentials;
	generateUuid: () => string;
	onStreamingResult: StreamingAggregatorOnEntry;
}): BuildStreamingResult {
	const sortedMapId = input.generateUuid();
	// drain() is intentionally untouched in the current production path —
	// it's an in-memory buffer kept for future formatter integrations that
	// need to emit a final summary across all streamed entries (e.g. JSON
	// envelope with per-pkg summaries). Today the aggregator's sole job is
	// per-arrival dedupe + forwarding to onStreamingResult.
	const aggregator = new StreamingAggregator({ onEntry: input.onStreamingResult });
	const reader = new StreamingResultClient({
		baseUrl: input.credentials.baseUrl,
		credentials: {
			apiKey: input.credentials.apiKey,
			universeId: input.credentials.universeId,
		},
		mapId: sortedMapId,
	});

	return {
		hooks: {
			onPackageResult: (entry) => {
				aggregator.accept(entry);
			},
			reader,
		},
		sortedMapId,
	};
}

/**
 * The one script every worker on this run's queue boots into.
 * @param options - Bail flag, inputs, queue and streaming.
 * @param options.bail - Whether to stop on the first failing package.
 * @param options.generateUuid - ID generator for the script.
 * @param options.inputs - Materializer inputs of the batch.
 * @param options.prepared - Prepared queue.
 * @param options.streaming - Streaming result map, if streaming is on.
 * @returns The Luau script source.
 */
function buildStealingScript({
	bail,
	generateUuid,
	inputs,
	prepared,
	streaming,
}: {
	bail: boolean;
	generateUuid: () => string;
	inputs: ReadonlyArray<MaterializerInput>;
	prepared: PreparedWorkStealing;
	streaming: BuildStreamingResult | undefined;
}): string {
	return generateWorkStealingScript({
		bail,
		inputs,
		invisibilityWindowSeconds: prepared.invisibilityWindowSeconds,
		queueId: prepared.queueId,
		// Its own map rather than a reserved key in the results map: the
		// CLI polls that one and would have to decode past the signal, and
		// a bail without a streaming consumer would publish per-package
		// summaries nobody drains just to keep the channel open.
		...(bail ? { bailMapId: generateUuid() } : {}),
		queueTtlSeconds: prepared.ttlSeconds,
		...(streaming === undefined ? {} : { streaming: { sortedMapId: streaming.sortedMapId } }),
	});
}

async function prepareStealingDispatchAsync({
	bail,
	credentials,
	generateUuid,
	inputs,
	onStreamingResult,
	parallel,
	prepareWorkStealingQueue,
}: WorkStealingDispatchInput): Promise<StealingDispatchSpec> {
	// Gate streaming setup on an actual consumer. Without `onStreamingResult`
	// (JSON/agent/silent runs) the SortedMap polling has no sink — running
	// it anyway burns HTTP quota and risks the one-shot stderr warning
	// leaking into structured output. Skip the SortedMap path entirely;
	// the final batched envelope still drives per-package output files.
	const streaming =
		onStreamingResult !== undefined
			? buildStreaming({ credentials, generateUuid, onStreamingResult })
			: undefined;

	// Enqueued last, so nothing after this point can throw and strand the
	// items: a caller that falls back to the bucketed path would otherwise
	// leave a full queue behind until its ten-minute TTL expires.
	const prepared = await prepareWorkStealingQueue({
		baseUrl: credentials.baseUrl,
		credentials: { apiKey: credentials.apiKey, universeId: credentials.universeId },
		packages: inputs.map((entry) => ({ pkg: entry.pkg, project: entry.project })),
		perPackageTimeoutSeconds: longestPackageSeconds(inputs),
	});

	const script = buildStealingScript({
		bail,
		generateUuid,
		inputs,
		prepared,
		streaming,
	});

	return {
		parallel,
		scriptOverride: script,
		...(streaming === undefined ? {} : { streaming: streaming.hooks }),
		workStealing: true,
	};
}
