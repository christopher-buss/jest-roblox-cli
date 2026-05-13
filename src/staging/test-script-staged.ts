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
	streaming?: StreamingOptions;
}

interface StreamingOptions {
	/** Per-run UUID-keyed SortedMap id for live per-package result publish. */
	sortedMapId: string;
	/** TTL applied to each SortedMap write. Defaults to the materializer's 600s. */
	ttlSeconds?: number;
}

interface EntryPayload {
	config: JestArgv;
	pkg: string;
	project: string;
}

interface StreamingPayloadFields {
	sortedMapId?: string;
	streamingTtlSeconds?: number;
}

interface MaterializerPayload extends StreamingPayloadFields {
	entries: Array<EntryPayload>;
}

interface WorkStealingPayload extends StreamingPayloadFields {
	entries: Array<EntryPayload>;
	invisibilityWindowSeconds: number;
	queueId: string;
}

export function generateMaterializerScript(
	inputs: Array<MaterializerInput>,
	options: ScriptOptions = {},
): string {
	const payload: MaterializerPayload = {
		entries: buildEntries(inputs),
		...streamingFields(options.streaming),
	};
	return substitutePayload(payload);
}

/**
 * Generate the materializer script for work-stealing mode. The Roblox-side
 * runtime sees the `queueId` field and switches from sequential walk to
 * popping items off `MemoryStoreService:GetQueue(queueId, invisibilityWindowSeconds)`,
 * looking each one up in the embedded `entries` map.
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
		entries: buildEntries(inputs),
		invisibilityWindowSeconds,
		queueId,
		...streamingFields(options.streaming),
	};
	return substitutePayload(payload);
}

function streamingFields(streaming: StreamingOptions | undefined): StreamingPayloadFields {
	if (streaming === undefined) {
		return {};
	}

	return {
		sortedMapId: streaming.sortedMapId,
		...(streaming.ttlSeconds !== undefined
			? { streamingTtlSeconds: streaming.ttlSeconds }
			: {}),
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

function substitutePayload(payload: object): string {
	const serialized = String(JSON.stringify(payload));
	if (serialized.includes("]==]")) {
		throw new Error("workspace materializer payload contains forbidden sequence ']==]'");
	}

	return template.replace("__CONFIG_JSON__", () => serialized);
}
