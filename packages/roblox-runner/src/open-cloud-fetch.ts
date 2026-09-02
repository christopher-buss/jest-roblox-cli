import type { HttpClient } from "@bedrock-rbx/ocale";
import { ApiError, NetworkError } from "@bedrock-rbx/ocale";

export const DEFAULT_BASE_URL = "https://apis.roblox.com";

/**
 * Minimal fetch transport for the Open Cloud endpoints the ocale SDK does not
 * model — the universe-wide `memory-store:flush` and the messaging publish.
 * Both are single calls against a fixed URL, so neither earns a generated
 * client, but both need the SDK's own failure classification or their callers
 * cannot tell a refusal from a dropped connection: non-2xx ⇒ `ApiError`
 * failure, thrown fetch ⇒ `NetworkError` failure.
 *
 * A request carrying no body sends none and declares no content type, so an
 * endpoint that takes no arguments posts nothing rather than an empty JSON
 * document.
 */
export function createFetchHttpClient(): HttpClient {
	return {
		request: async (request, config) => {
			try {
				const response = await fetch(
					`${config.baseUrl}${request.url}`,
					toRequestInit(request, config.apiKey),
				);
				return await classifyResponseAsync(response);
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

async function classifyResponseAsync(
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
 * The fetch call one Open Cloud request describes, keyed by the API key.
 * Serializing here rather than at the caller keeps the transport the only place
 * that knows this wire is JSON.
 */
function toRequestInit(request: Parameters<HttpClient["request"]>[0], apiKey: string): RequestInit {
	if (request.body === undefined) {
		return { headers: { "x-api-key": apiKey }, method: request.method };
	}

	return {
		body: JSON.stringify(request.body),
		headers: { "content-type": "application/json", "x-api-key": apiKey },
		method: request.method,
	};
}
