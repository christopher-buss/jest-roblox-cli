import type { HttpClient } from "@bedrock-rbx/ocale";
import { ApiError, NetworkError } from "@bedrock-rbx/ocale";

export interface FlushMemoryStoreOptions {
	readonly apiKey: string;
	readonly baseUrl?: string | undefined;
	readonly httpClient?: HttpClient;
	readonly universeId: string;
}

const DEFAULT_BASE_URL = "https://apis.roblox.com";

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

async function classifyFlushResponseAsync(
	response: Response,
): Promise<Awaited<ReturnType<HttpClient["request"]>>> {
	if (!response.ok) {
		const body = await response.text();
		return {
			err: new ApiError(`HTTP ${response.status}: ${body}`, {
				statusCode: response.status,
			}),
			success: false,
		};
	}

	return {
		data: { body: undefined, headers: {}, status: response.status },
		success: true,
	};
}

/**
 * Minimal fetch transport for the one endpoint the ocale SDK does not model.
 * Classifies like the SDK's own transport: non-2xx ⇒ `ApiError` failure,
 * thrown fetch ⇒ `NetworkError` failure.
 */
function createFetchHttpClient(): HttpClient {
	return {
		request: async (request, config) => {
			try {
				const response = await fetch(`${config.baseUrl}${request.url}`, {
					headers: { "x-api-key": config.apiKey },
					method: request.method,
				});
				return await classifyFlushResponseAsync(response);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					err: new NetworkError(message, { cause: err }),
					success: false,
				};
			}
		},
	};
}
