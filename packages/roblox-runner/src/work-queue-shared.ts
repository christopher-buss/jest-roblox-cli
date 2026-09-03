import type {
	HttpClient,
	OpenCloudClientOptions,
	OpenCloudError,
	Result,
	SleepFunc,
} from "@bedrock-rbx/ocale";
import type {
	DequeueQueueItemsParameters,
	EnqueueQueueItemParameters,
	QueueItem,
} from "@bedrock-rbx/ocale/storage";
import { StorageClient } from "@bedrock-rbx/ocale/storage";

export type QueueData = EnqueueQueueItemParameters["data"];

/**
 * One dequeue's worth of items, with the claim to acknowledge them by. An
 * absent `readId` is the one signal that the read was empty — nothing was
 * claimed, so there is nothing to discard and no reason to sweep again.
 */
export interface QueueRead {
	readonly items: ReadonlyArray<QueueItem>;
	readonly readId: string | undefined;
}

/**
 * A dequeue that takes whatever is at the front of the queue, so its 404 can
 * only mean the queue is empty.
 *
 * `allOrNothing` is what takes that away: with it set, the server answers 404
 * when *fewer than* `count` items are available, so the status stops proving
 * the queue is empty and starts meaning "not this many". Reading that as an
 * empty queue would drop a partial batch on the floor. Forbid the flag rather
 * than branch on it — nothing here asks for all-or-nothing delivery, and a
 * caller that starts to must reach for `storage.queues.dequeue` directly and
 * say what its own 404 means.
 */
type BestEffortDequeueParameters = DequeueQueueItemsParameters & {
	readonly allOrNothing?: never;
};

/**
 * The canonical status `items:read` answers when no item is visible: a 404
 * carrying `{"error":"NOT_FOUND"}`.
 */
const EMPTY_READ_CODE = "NOT_FOUND";
const EMPTY_READ = {
	data: { items: [], readId: undefined },
	success: true,
} satisfies Result<QueueRead, never>;

interface WorkQueueStorageOptions {
	readonly apiKey: string;
	readonly baseUrl?: string | undefined;
	readonly httpClient?: HttpClient;
	readonly sleep?: SleepFunc;
}

export function createWorkQueueStorage(options: WorkQueueStorageOptions): StorageClient {
	let clientOptions: OpenCloudClientOptions = { apiKey: options.apiKey };
	if (options.baseUrl !== undefined) {
		clientOptions = { ...clientOptions, baseUrl: options.baseUrl };
	}

	if (options.httpClient !== undefined) {
		clientOptions = { ...clientOptions, httpClient: options.httpClient };
	}

	if (options.sleep !== undefined) {
		clientOptions = { ...clientOptions, sleep: options.sleep };
	}

	return new StorageClient(clientOptions);
}

/**
 * Dequeue, reporting the API's empty read as an empty success rather than a
 * failure.
 *
 * `items:read` answers 404 `NOT_FOUND` "Queue items not found." when no item
 * is visible. That is the endpoint's empty read, not a fault — it never
 * answers a 200 with an empty item list. A queue that was never created
 * answers byte-identically, and to a caller draining or claiming from one both
 * mean the same thing: there is nothing here.
 *
 * Keyed on the canonical status rather than on the 404, because the same
 * endpoint answers 404 for a moved or retired route too, with the legacy
 * `{"errors":[{"code":0}]}` envelope. Swallowing every 404 would report an
 * empty queue for the rest of the process's life, silently. That one stays a
 * failure, and each caller words it their own way.
 *
 * The read must be one whose 404 can only mean empty — see
 * {@link BestEffortDequeueParameters}.
 */
export async function dequeueOrEmptyAsync(
	storage: StorageClient,
	parameters: BestEffortDequeueParameters,
): Promise<Result<QueueRead, OpenCloudError>> {
	const read = await storage.queues.dequeue(parameters);
	if (!read.success) {
		return read.err.code === EMPTY_READ_CODE ? EMPTY_READ : read;
	}

	// A 200 carrying no item is not a shape the endpoint has ever been seen to
	// answer with, but it means the same thing, and answering it with the same
	// value spares every caller a second way to spell "empty".
	if (read.data.items.length === 0) {
		return EMPTY_READ;
	}

	return { data: { items: read.data.items, readId: read.data.readId }, success: true };
}

export function msToSecondsCeil(ms: number): number {
	return Math.max(1, Math.ceil(ms / 1000));
}
