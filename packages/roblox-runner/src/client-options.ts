import { createFetchHttpClient, TRANSIENT_TRANSPORT_CODES } from "@bedrock-rbx/ocale";
import type {
	HttpClient,
	OpenCloudClientOptions,
	RequestOptions,
	SleepFunc,
} from "@bedrock-rbx/ocale";
import { StorageClient } from "@bedrock-rbx/ocale/storage";

/** Open Cloud authorization, endpoint and transport for one universe. */
export interface OpenCloudConnection {
	/** Open Cloud key; never include it in diagnostic evidence. */
	readonly apiKey: string;
	/** Override the Open Cloud endpoint for a compatible transport. */
	readonly baseUrl?: string | undefined;
	/** Inject transport without replacing the SDK retry policy. */
	readonly httpClient?: HttpClient;
	/** Universe resource ID shared by execution and storage. */
	readonly universeId: string;
}

/** A connection whose SDK client paces and retries its requests. */
export interface PacedConnection extends OpenCloudConnection {
	/** Inject waits used by SDK pacing and retries. */
	readonly sleep?: SleepFunc;
}

type ClientOptionKey = "baseUrl" | "httpClient" | "maxRetries" | "sleep";
type ClientOptions = { [Key in ClientOptionKey]?: OpenCloudClientOptions[Key] | undefined };

type ResolvedClientOptions = OpenCloudClientOptions & { httpClient: HttpClient };

interface SubmitRequestPolicy {
	isSubmitIdempotent: boolean;
	retrySubmitTransportErrors: boolean;
	signal: AbortSignal;
	submitBudget: number | undefined;
	timeout: number;
}

/**
 * Omitted overrides retain SDK defaults; explicit zero retries must survive.
 * @param apiKey - Key authorized for the requested Open Cloud operations.
 * @param options - Optional SDK overrides supplied by the consumer.
 * @returns SDK options with a concrete injectable transport.
 */
export function createClientOptions(
	apiKey: string,
	options: ClientOptions | undefined,
): ResolvedClientOptions {
	let clientOptions: ResolvedClientOptions = {
		apiKey,
		httpClient: options?.httpClient ?? createFetchHttpClient(),
	};
	if (options?.baseUrl !== undefined) {
		clientOptions = { ...clientOptions, baseUrl: options.baseUrl };
	}

	if (options?.maxRetries !== undefined) {
		clientOptions = { ...clientOptions, maxRetries: options.maxRetries };
	}

	if (options?.sleep !== undefined) {
		clientOptions = { ...clientOptions, sleep: options.sleep };
	}

	return clientOptions;
}

/**
 * Bind storage operations to the configured SDK transport and credentials.
 * @param options - API key and optional SDK request overrides.
 * @returns A storage client using SDK defaults for omitted overrides.
 */
export function createStorageClient(options: ClientOptions & { apiKey: string }): StorageClient {
	return new StorageClient(createClientOptions(options.apiKey, options));
}

const SAFE_SUBMIT_RETRY_STATUSES = [429, 500, 502, 503, 504];
const BUDGETED_SUBMIT_MAX_RETRIES = 32;
/**
 * Resolve SDK create policy from caller idempotency, retry and budget choices.
 * @param options - Request cancellation, timeout and submission retry policy.
 * @returns SDK options retaining default retry counts for unbudgeted requests.
 */
export function createSubmitRequestOptions(options: SubmitRequestPolicy): RequestOptions {
	return {
		...(options.submitBudget === undefined ? {} : { maxRetries: BUDGETED_SUBMIT_MAX_RETRIES }),
		...(options.isSubmitIdempotent ? { retryableStatuses: SAFE_SUBMIT_RETRY_STATUSES } : {}),
		retryableTransportCodes: options.retrySubmitTransportErrors
			? TRANSIENT_TRANSPORT_CODES
			: [],
		signal: options.signal,
		timeout: options.timeout,
	};
}
