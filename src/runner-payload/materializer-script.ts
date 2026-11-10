import template from "../materializer.bundled.luau";
import type { EmbeddedEntry, EmbeddedPayload } from "../protocol/embedded-payload-types.ts";
import { embedConfigJson } from "../protocol/long-string.ts";
import { indexArgv, type IndexedJestArgv, type JestArgv } from "./jest-argv.ts";

/** One project run the materializer script carries. */
export type MaterializerInput = EmbeddedEntry<IndexedJestArgv>;

/** A job as the materializer reads it; a workspace job names its package. */
export interface MaterializerJob {
	/** The job's runner argv. */
	argv: JestArgv;
	/** Project display name the result is reported under. */
	displayName: string;
	/** Staged package the job runs in. */
	pkg?: string | undefined;
}

/** Bail, budget and streaming options shared by both script modes. */
export interface ScriptOptions {
	/** Stop the task as soon as a package fails. */
	bail?: boolean;
	/** SortedMap id a bail is broadcast through; used only with `bail`. */
	bailMapId?: string | undefined;
	/** TTL the queue items were seeded with, in seconds. */
	queueTtlSeconds?: number;
	/** Cap on one task's encoded return envelope, in bytes. */
	resultBudgetBytes?: number;
	/** Publish each package result to a SortedMap as it finishes. */
	streaming?: StreamingOptions;
}

interface StreamingOptions {
	sortedMapId: string;
	ttlSeconds?: number;
}

interface WorkStealingOptions extends ScriptOptions {
	inputs: Array<MaterializerInput>;
	invisibilityWindowSeconds: number;
	queueId: string;
}

type MaterializerPayload = Pick<
	EmbeddedPayload<IndexedJestArgv>,
	"bail" | "bailMapId" | "entries" | "sortedMapId" | "streamingTtlSeconds"
>;

type WorkStealingPayload = MaterializerPayload &
	Pick<EmbeddedPayload<IndexedJestArgv>, "queueTtlSeconds" | "resultBudgetBytes"> &
	Required<Pick<EmbeddedPayload<IndexedJestArgv>, "invisibilityWindowSeconds" | "queueId">>;

/**
 * The materializer entry for one workspace job.
 * @param job - The job to embed.
 * @param jobIndex - Index of the job in the request.
 * @returns The entry the materializer runs.
 * @throws {@link Error} When the job names no package.
 */
export function toMaterializerEntry(
	{ argv, displayName, pkg }: MaterializerJob,
	jobIndex: number,
): MaterializerInput {
	if (pkg === undefined) {
		throw new Error(
			`Workspace entry for project "${displayName}" is missing its package name (pkg)`,
		);
	}

	return { config: indexArgv(argv, jobIndex), pkg, project: displayName };
}

/**
 * Generate the materializer script that walks the inputs in order.
 * @param inputs - Project runs to embed.
 * @param options - Bail and streaming options.
 * @returns The Luau script with the payload substituted.
 */
export function generateMaterializerScript(
	inputs: Array<MaterializerInput>,
	options: ScriptOptions = {},
): string {
	const payload: MaterializerPayload = {
		...bailFields(options),
		entries: inputs,
		...streamingFields(options.streaming),
	};
	return substitutePayload(payload);
}

/**
 * Generate the materializer script for work-stealing mode.
 * @param options - Inputs, queue id and window, and shared script options.
 * @returns The Luau script with the payload substituted.
 */
export function generateWorkStealingScript(options: WorkStealingOptions): string {
	const payload: WorkStealingPayload = {
		...bailFields(options),
		entries: options.inputs,
		invisibilityWindowSeconds: options.invisibilityWindowSeconds,
		queueId: options.queueId,
		queueTtlSeconds: options.queueTtlSeconds,
		resultBudgetBytes: options.resultBudgetBytes,
		...streamingFields(options.streaming),
	};
	return substitutePayload(payload);
}

/**
 * Omit unset fields so the payload stays cache-comparable without `bail`.
 *
 * @param options - Script options holding the bail settings.
 * @returns The bail payload fields, empty without `bail`.
 */
function bailFields(options: ScriptOptions): Pick<MaterializerPayload, "bail" | "bailMapId"> {
	if (options.bail !== true) {
		return {};
	}

	return {
		bail: true,
		...(options.bailMapId !== undefined ? { bailMapId: options.bailMapId } : {}),
	};
}

function streamingFields(
	streaming: StreamingOptions | undefined,
): Pick<MaterializerPayload, "sortedMapId" | "streamingTtlSeconds"> {
	if (streaming === undefined) {
		return {};
	}

	return {
		sortedMapId: streaming.sortedMapId,
		streamingTtlSeconds: streaming.ttlSeconds,
	};
}

function substitutePayload(payload: MaterializerPayload | WorkStealingPayload): string {
	return embedConfigJson(template, JSON.stringify(payload));
}
