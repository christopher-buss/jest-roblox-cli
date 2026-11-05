import { ApiError, RequestAbortedError } from "@bedrock-rbx/ocale";
import type { StorageClient } from "@bedrock-rbx/ocale/storage";

import { type } from "arktype";

import { resolveStorageClient } from "../memory-store/sorted-map-page.ts";

const EXECUTION_CLAIM_MAP_ID = "jest-roblox-execution-v1";

export const EXECUTION_NOT_CLAIMED = "__JEST_ROBLOX_EXECUTION_NOT_CLAIMED__";
export const EXECUTION_START_EXPIRED = "__JEST_ROBLOX_EXECUTION_START_EXPIRED__";

const executionClaimSchema = type({ claimedAt: "number", owner: "string" });

/** The result of one read of an execution claim. */
export type ExecutionClaimObservation =
	| {
			/** The read failure or an invalid stored claim. */
			error: Error;
			status: "failed";
	  }
	| {
			/** The stored claim. */
			claim: {
				/** When the claim was taken. */
				claimedAt: number;
				/** The identity that took the claim. */
				owner: string;
			};
			status: "found";
	  }
	| { status: "missing" };

/** Open Cloud access for an {@link ExecutionClaimObserver}. */
export interface ExecutionClaimObserverOptions {
	/** Override for the Open Cloud base URL. */
	baseUrl?: string | undefined;
	/** The Open Cloud API key and the universe that holds the claim map. */
	credentials: {
		/** The Open Cloud API key. */
		apiKey: string;
		/** The universe that holds the claim map. */
		universeId: string;
	};
	/** Override that builds the storage client. */
	storageFactory?: () => StorageClient;
}

/** Read the runtime's at-most-once claim through Open Cloud. */
export class ExecutionClaimObserver {
	private readonly storage: StorageClient;
	private readonly universeId: string;

	/**
	 * Bind the observer to one universe's claim map.
	 * @param options - Credentials and optional client overrides.
	 */
	constructor(options: ExecutionClaimObserverOptions) {
		this.storage = resolveStorageClient(options);
		this.universeId = options.credentials.universeId;
	}

	/**
	 * Read the claim stored under one key.
	 * @param key - The item ID in the claim map.
	 * @param signal - Cancels the pending request.
	 * @returns The found claim, its absence, or the read failure.
	 * @rejects When the read is aborted.
	 */
	public async readAsync(key: string, signal?: AbortSignal): Promise<ExecutionClaimObservation> {
		const result = await this.storage.sortedMaps.get(
			{
				itemId: key,
				mapId: EXECUTION_CLAIM_MAP_ID,
				universeId: this.universeId,
			},
			signal === undefined ? {} : { signal },
		);
		if (result.success) {
			const claim = executionClaimSchema(result.data.value);
			return claim instanceof type.errors
				? {
						error: new Error(`Invalid execution claim: ${claim.summary}`, {
							cause: claim,
						}),
						status: "failed",
					}
				: { claim, status: "found" };
		}

		if (result.err instanceof ApiError && result.err.statusCode === 404) {
			return { status: "missing" };
		}

		// A cancelled read is the caller's own decision; reported as `failed` it
		// would read as evidence the runtime is unreachable.
		if (result.err instanceof RequestAbortedError) {
			throw result.err;
		}

		return { error: result.err, status: "failed" };
	}
}
