import type { HttpClient, OpenCloudError } from "@bedrock-rbx/ocale";
import { ApiError } from "@bedrock-rbx/ocale";

import { createFetchHttpClient, DEFAULT_BASE_URL } from "./open-cloud-fetch.ts";

export interface PublishMessageOptions {
	readonly apiKey: string;
	readonly baseUrl?: string | undefined;
	readonly httpClient?: HttpClient;
	/** Payload delivered verbatim as the subscriber's `message.Data`. */
	readonly message: string;
	/** Topic the in-engine `MessagingService:SubscribeAsync` listens on. */
	readonly topic: string;
	readonly universeId: string;
}

/**
 * The scope an Open Cloud key needs to publish. Named in the failure because
 * Roblox refuses a key it will not accept with a flat `Invalid API Key` that
 * says nothing about which permission is short.
 */
const PUBLISH_SCOPE = "universe-messaging-service:publish";

/**
 * Publish one message to a universe topic — the push channel into a running
 * Open Cloud Luau Execution task, which can subscribe to it with
 * `MessagingService:SubscribeAsync` (measured: a task reaches a published
 * message in ~1s, and the engine call is not sandboxed away). The SDK has no
 * messaging operation, so this goes through the raw {@link HttpClient} seam the
 * same way `flushMemoryStoreAsync` does.
 *
 * Throws on any failure. Open Cloud guarantees no delivery, so a caller may
 * well shrug one off — but that is the caller's call to make. A refused key has
 * to be able to reach a human, and swallowing it here would make a missing
 * scope indistinguishable from a delivered message.
 */
export async function publishMessageAsync(options: PublishMessageOptions): Promise<void> {
	const httpClient = options.httpClient ?? createFetchHttpClient();
	const result = await httpClient.request(
		{
			body: { message: options.message, topic: options.topic },
			method: "POST",
			url: `/cloud/v2/universes/${options.universeId}:publishMessage`,
		},
		{
			apiKey: options.apiKey,
			baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
		},
	);
	if (!result.success) {
		throw new Error(
			`Failed to publish to topic ${options.topic} on universe ${options.universeId}: ` +
				`${result.err.message}${describeScopeHint(result.err)}`,
		);
	}
}

/**
 * The permission line to add when the key itself was refused, and nothing
 * otherwise. Any other 4xx is a bug in the request, not a missing scope, and
 * pointing at the key would send the reader to the wrong place.
 */
function describeScopeHint(err: OpenCloudError): string {
	if (!(err instanceof ApiError)) {
		return "";
	}

	return err.statusCode === 401 || err.statusCode === 403
		? ` — the API key needs the ${PUBLISH_SCOPE} permission`
		: "";
}
