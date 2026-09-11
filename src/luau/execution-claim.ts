import { ApiError } from "@bedrock-rbx/ocale";
import type { StorageClient } from "@bedrock-rbx/ocale/storage";

import { type } from "arktype";

import { resolveStorageClient } from "../memory-store/sorted-map-page.ts";

const EXECUTION_CLAIM_MAP_ID = "jest-roblox-execution-v1";

export const EXECUTION_NOT_CLAIMED = "__JEST_ROBLOX_EXECUTION_NOT_CLAIMED__";
export const EXECUTION_START_EXPIRED = "__JEST_ROBLOX_EXECUTION_START_EXPIRED__";

const executionClaimSchema = type({ claimedAt: "number", owner: "string" });

export type ExecutionClaimObservation =
	| { claim: { claimedAt: number; owner: string }; status: "found" }
	| { error: Error; status: "failed" }
	| { status: "missing" };

export interface ExecutionClaimObserverOptions {
	baseUrl?: string | undefined;
	credentials: { apiKey: string; universeId: string };
	storageFactory?: () => StorageClient;
}

/** Read the runtime's at-most-once claim through Open Cloud. */
export class ExecutionClaimObserver {
	private readonly storage: StorageClient;
	private readonly universeId: string;

	constructor(options: ExecutionClaimObserverOptions) {
		this.storage = resolveStorageClient(options);
		this.universeId = options.credentials.universeId;
	}

	public async readAsync(key: string): Promise<ExecutionClaimObservation> {
		const result = await this.storage.sortedMaps.get({
			itemId: key,
			mapId: EXECUTION_CLAIM_MAP_ID,
			universeId: this.universeId,
		});
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

		return { error: result.err, status: "failed" };
	}
}
