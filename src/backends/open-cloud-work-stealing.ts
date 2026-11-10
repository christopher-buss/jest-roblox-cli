import process from "node:process";

import { StreamingResultClient } from "../memory-store/sorted-map-client.ts";
import type {
	PreparedWorkStealing,
	prepareWorkStealingQueueAsync,
} from "../memory-store/work-stealing.ts";
import {
	generateWorkStealingScript,
	type MaterializerInput,
} from "../runner-payload/materializer-script.ts";
import { errorMessage } from "../utils/error-message.ts";
import type { StreamingHooks } from "./open-cloud-pool.ts";

/** The script every work-stealing task runs, and its result stream. */
export interface PreparedStealing {
	/** Luau source every task runs. */
	script: string;
	/** Result stream, when a consumer asked for one. */
	streaming: StreamingHooks | undefined;
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
	onPackageResult?: StreamingHooks["onPackageResult"] | undefined;
	/** Queue preparation, injectable for tests. */
	prepareWorkStealingQueue: typeof prepareWorkStealingQueueAsync;
	/** Deadline Roblox gives every task of the run, in milliseconds. */
	taskTimeout: number;
}

/** Open Cloud access for the work-stealing queue and result map. */
interface WorkStealingCredentials {
	/** Open Cloud API key with MemoryStore access. */
	apiKey: string;
	/** Override the Open Cloud base URL. */
	baseUrl?: string | undefined;
	/** Universe that owns the queue and the map. */
	universeId: string;
}

interface BuildStreamingResult {
	hooks: StreamingHooks;
	sortedMapId: string;
}

/**
 * Set up the queue and build the script every work-stealing task runs.
 * @param input - Credentials, materializer inputs and queue seams.
 * @returns The script and stream, or `undefined` after warning that the
 *   queue setup failed.
 */
export async function tryStealingDispatchAsync({
	bail,
	credentials,
	generateUuid,
	inputs,
	onPackageResult,
	prepareWorkStealingQueue,
	taskTimeout,
}: WorkStealingDispatchInput): Promise<PreparedStealing | undefined> {
	const streaming =
		onPackageResult !== undefined
			? buildStreaming({ credentials, generateUuid, onPackageResult })
			: undefined;

	let prepared: PreparedWorkStealing;
	try {
		// Enqueue last: a throw after this strands the items in the queue.
		prepared = await prepareWorkStealingQueue({
			baseUrl: credentials.baseUrl,
			credentials: { apiKey: credentials.apiKey, universeId: credentials.universeId },
			packages: inputs.map((entry) => ({ pkg: entry.pkg, project: entry.project })),
			perPackageTimeoutSeconds: longestPackageSeconds(inputs, taskTimeout),
		});
	} catch (err) {
		process.stderr.write(
			"Warning: could not set up the work-stealing queue, running packages " +
				`with no work-stealing: ${errorMessage(err)}\n` +
				"Grant the API key memory-store.queue:add/dequeue/discard so tasks " +
				"can rebalance instead of running a fixed share each.\n",
		);
		return undefined;
	}

	const script = buildStealingScript({ bail, generateUuid, inputs, prepared, streaming });
	return { script, streaming: streaming?.hooks };
}

function longestPackageSeconds(inputs: Array<MaterializerInput>, taskTimeout: number): number {
	let longestMs = 0;
	for (const { config } of inputs) {
		const budgetMs = config.runnerTimeoutMs;
		longestMs = Math.max(
			longestMs,
			budgetMs === undefined ? taskTimeout : Math.min(budgetMs, taskTimeout),
		);
	}

	return Math.ceil(longestMs / 1000);
}

function buildStreaming(input: {
	credentials: WorkStealingCredentials;
	generateUuid: () => string;
	onPackageResult: StreamingHooks["onPackageResult"];
}): BuildStreamingResult {
	const sortedMapId = input.generateUuid();
	const reader = new StreamingResultClient({
		baseUrl: input.credentials.baseUrl,
		credentials: {
			apiKey: input.credentials.apiKey,
			universeId: input.credentials.universeId,
		},
		mapId: sortedMapId,
	});

	return {
		hooks: { onPackageResult: input.onPackageResult, reader },
		sortedMapId,
	};
}

function buildStealingScript({
	bail,
	generateUuid,
	inputs,
	prepared,
	streaming,
}: {
	bail: boolean;
	generateUuid: () => string;
	inputs: Array<MaterializerInput>;
	prepared: PreparedWorkStealing;
	streaming: BuildStreamingResult | undefined;
}): string {
	return generateWorkStealingScript({
		bail,
		inputs,
		invisibilityWindowSeconds: prepared.invisibilityWindowSeconds,
		queueId: prepared.queueId,
		...(bail ? { bailMapId: generateUuid() } : {}),
		queueTtlSeconds: prepared.ttlSeconds,
		...(streaming === undefined ? {} : { streaming: { sortedMapId: streaming.sortedMapId } }),
	});
}
