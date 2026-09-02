import type { HttpClient } from "@bedrock-rbx/ocale";

import { createFetchHttpClient, DEFAULT_BASE_URL } from "./open-cloud-fetch.ts";

export interface FlushMemoryStoreOptions {
	readonly apiKey: string;
	readonly baseUrl?: string | undefined;
	readonly httpClient?: HttpClient;
	readonly universeId: string;
}

/**
 * Issue the **universe-wide** `memory-store:flush` — it destroys every queue,
 * sorted map, and hash map in the universe, including a concurrent run's
 * in-flight work. Never called automatically; the one legitimate caller is an
 * operator who owns the universe exclusively and asked for it by flag. The SDK
 * has no flush operation, so this goes through the raw {@link HttpClient}
 * seam. Throws on any failure: the caller opted into a destructive
 * precondition, so a flush that did not happen must not go unnoticed.
 */
export async function flushMemoryStoreAsync(options: FlushMemoryStoreOptions): Promise<void> {
	const httpClient = options.httpClient ?? createFetchHttpClient();
	const result = await httpClient.request(
		{
			method: "POST",
			url: `/cloud/v2/universes/${options.universeId}/memory-store:flush`,
		},
		{
			apiKey: options.apiKey,
			baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
		},
	);
	if (!result.success) {
		throw new Error(
			`Failed to flush universe ${options.universeId} MemoryStore: ${result.err.message}`,
		);
	}
}
