import type { ScriptResult } from "@isentinel/roblox-runner";
import { ExecutionTimeoutError } from "@isentinel/roblox-runner";

/**
 * Deliver the held original only after recovery proves the claim was acquired.
 */
export async function observeDelayedOriginalAsync({
	executeDelayedAsync,
	recoverAsync,
}: {
	executeDelayedAsync: (signal: AbortSignal) => Promise<ScriptResult>;
	recoverAsync: (signal: AbortSignal) => Promise<ScriptResult>;
}): Promise<[ScriptResult, ScriptResult]> {
	const observation = new AbortController();
	try {
		const recovered = await recoverAsync(observation.signal);
		const delayed = await executeDelayedAsync(observation.signal).catch(
			async (err: unknown) => {
				if (!(err instanceof ExecutionTimeoutError)) {
					throw err;
				}

				return err.readResultAsync(observation.signal);
			},
		);
		return [recovered, delayed];
	} finally {
		observation.abort();
	}
}
