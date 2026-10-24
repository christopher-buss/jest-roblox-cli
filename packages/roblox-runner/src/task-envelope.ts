import type {
	CompleteTask,
	SubmitAtHeadParameters,
	SubmitAtVersionParameters,
} from "@bedrock-rbx/ocale/luau-execution";

import type { RunnerCredentials, ScriptResult } from "./runner-types.ts";

interface TaskParametersInput {
	readonly binaryInput: string | undefined;
	readonly credentials: RunnerCredentials;
	readonly placeVersion: number | undefined;
	readonly script: string;
	readonly timeoutSeconds: number;
}

/**
 * Retain terminal evidence while serializing every returned JSON value.
 * @param task - Original task identity and server result.
 * @param startTime - Host execution start in Unix milliseconds.
 * @returns Serialized script outputs, elapsed time and terminal task evidence.
 */
export function completedResult(task: CompleteTask, startTime: number): ScriptResult {
	return {
		durationMs: Date.now() - startTime,
		outputs: task.output.results.map(coerceOutputToString),
		terminalTask: {
			ref: { sessionId: task.ref.sessionId, taskId: task.ref.taskId },
			state: task.state,
		},
	};
}

/**
 * The task a submit describes. `versionId` and `binaryInput` are each present
 * or the key is absent — the parameters never carry one as `undefined`, which
 * the client would send.
 * @param input - Credentials, script, execution deadline and optional pinned inputs.
 * @returns Pinned-version or head submission parameters with optional binary input.
 */
export function buildTaskParameters({
	binaryInput,
	credentials,
	placeVersion,
	script,
	timeoutSeconds,
}: TaskParametersInput): SubmitAtHeadParameters | SubmitAtVersionParameters {
	const base = {
		...(binaryInput === undefined ? {} : { binaryInput }),
		placeId: credentials.placeId,
		script,
		timeoutSeconds,
		universeId: credentials.universeId,
	};
	return placeVersion === undefined ? base : { ...base, versionId: String(placeVersion) };
}

function coerceOutputToString(value: JSONValue): string {
	if (typeof value === "string") {
		return value;
	}

	// Bedrock's wire-parsed output.results is JSONValue (no undefined, function,
	// or symbol entries), so JSON.stringify always returns a string here.
	return JSON.stringify(value);
}
