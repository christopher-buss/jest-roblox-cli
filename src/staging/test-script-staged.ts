import type { ResolvedConfig } from "../config/schema.ts";
import template from "../materializer.bundled.luau";
import { buildJestArgv, type JestArgv } from "../test-script.ts";

export interface MaterializerInput {
	config: ResolvedConfig;
	pkg: string;
	project: string;
	testFiles: Array<string>;
}

export interface ScriptOptions {
	/**
	 * Stop the task as soon as a package fails, leaving the rest of the batch
	 * not run. Omit (or pass false) to run every package regardless.
	 */
	bail?: boolean;
	/**
	 * Per-run SortedMap id the parallel wave broadcasts a bail through. Only
	 * meaningful alongside `bail`; omit on the single-task path, which has no
	 * siblings to tell.
	 */
	bailMapId?: string | undefined;
	/**
	 * Caps the encoded size of one task's return envelope, in bytes. A worker
	 * that reaches the cap stops taking queue items and leaves them for the
	 * next task, so no task trips Open Cloud's 4 MiB limit on the value it
	 * returns. Omit to use the materializer's own default.
	 *
	 * Exists so a test can force the split with a small run rather than
	 * needing megabytes of real Jest output.
	 */
	resultBudgetBytes?: number;
	streaming?: StreamingOptions;
}

interface StreamingOptions {
	/** Per-run UUID-keyed SortedMap id for live per-package result publish. */
	sortedMapId: string;
	/**
	 * TTL applied to each SortedMap write. Defaults to the materializer's
	 * 600s.
	 */
	ttlSeconds?: number;
}

interface EntryPayload {
	config: JestArgv;
	pkg: string;
	project: string;
}

interface StreamingPayloadFields {
	sortedMapId?: string;
	streamingTtlSeconds?: number | undefined;
}

interface BailPayloadFields {
	bail?: boolean;
	bailMapId?: string;
}

interface MaterializerPayload extends BailPayloadFields, StreamingPayloadFields {
	entries: Array<EntryPayload>;
}

interface WorkStealingPayload extends BailPayloadFields, StreamingPayloadFields {
	entries: Array<EntryPayload>;
	invisibilityWindowSeconds: number;
	queueId: string;
	resultBudgetBytes?: number;
}

export function generateMaterializerScript(
	inputs: Array<MaterializerInput>,
	options: ScriptOptions = {},
): string {
	const payload: MaterializerPayload = {
		...bailFields(options),
		entries: buildEntries(inputs),
		...streamingFields(options.streaming),
	};
	return substitutePayload(payload);
}

/**
 * Generate the materializer script for work-stealing mode. The Roblox-side
 * runtime sees the `queueId` field and switches from sequential walk to
 * popping items off `MemoryStoreService:GetQueue(queueId,
 * invisibilityWindowSeconds)`, looking each one up in the embedded `entries`
 * map.
 *
 * When `options.streaming` is provided, each per-package result is also
 * published to `MemoryStoreService:GetSortedMap(sortedMapId):SetAsync(...)`
 * immediately after the package's `Jest.runCLI` returns, so the CLI can
 * stream output without waiting for the whole task envelope.
 */
export function generateWorkStealingScript(
	inputs: ReadonlyArray<MaterializerInput>,
	queueId: string,
	invisibilityWindowSeconds: number,
	options: ScriptOptions = {},
): string {
	const payload: WorkStealingPayload = {
		...bailFields(options),
		entries: buildEntries(inputs),
		invisibilityWindowSeconds,
		queueId,
		...(options.resultBudgetBytes !== undefined
			? { resultBudgetBytes: options.resultBudgetBytes }
			: {}),
		...streamingFields(options.streaming),
	};
	return substitutePayload(payload);
}

// Emitted only when set, so a run without --bail leaves the payload
// byte-for-byte what it was — the synthesized place and its script stay
// cache-comparable.
function bailFields(options: ScriptOptions): BailPayloadFields {
	if (options.bail !== true) {
		return {};
	}

	return {
		bail: true,
		...(options.bailMapId !== undefined ? { bailMapId: options.bailMapId } : {}),
	};
}

function streamingFields(streaming: StreamingOptions | undefined): StreamingPayloadFields {
	if (streaming === undefined) {
		return {};
	}

	return {
		sortedMapId: streaming.sortedMapId,
		streamingTtlSeconds: streaming.ttlSeconds,
	};
}

function buildEntries(inputs: ReadonlyArray<MaterializerInput>): Array<EntryPayload> {
	return inputs.map((input) => {
		return {
			config: buildJestArgv({ config: input.config, testFiles: input.testFiles }),
			pkg: input.pkg,
			project: input.project,
		};
	});
}

function substitutePayload(payload: MaterializerPayload | WorkStealingPayload): string {
	const serialized = JSON.stringify(payload);
	if (serialized.includes("]==]")) {
		throw new Error("workspace materializer payload contains forbidden sequence ']==]'");
	}

	return template.replace("__CONFIG_JSON__", () => serialized);
}
