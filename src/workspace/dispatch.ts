import type { DispatchKnobs } from "../backends/dispatch-request.ts";
import type { ParallelOption } from "../backends/interface.ts";
import { StreamingAggregator, type StreamingAggregatorOnEntry } from "./streaming-aggregator.ts";

interface WorkspaceDispatchInput {
	bail?: boolean | undefined;
	onStreamingResult?: StreamingAggregatorOnEntry | undefined;
	parallel?: ParallelOption;
	vmParallel?: ParallelOption;
}

/**
 * The dispatch options of a workspace run.
 * @param input - Bail, parallelism and streaming consumer.
 * @returns The dispatch options of the run.
 */
export function prepareWorkspaceDispatch({
	bail = false,
	onStreamingResult,
	parallel,
	vmParallel,
}: WorkspaceDispatchInput): DispatchKnobs {
	return {
		bail,
		parallel,
		vmParallel,
		workspace: { onPackageResult: streamThrough(onStreamingResult) },
	};
}

function streamThrough(
	onStreamingResult: StreamingAggregatorOnEntry | undefined,
): StreamingAggregatorOnEntry | undefined {
	if (onStreamingResult === undefined) {
		return undefined;
	}

	const aggregator = new StreamingAggregator({ onEntry: onStreamingResult });
	return (entry) => {
		aggregator.accept(entry);
	};
}
