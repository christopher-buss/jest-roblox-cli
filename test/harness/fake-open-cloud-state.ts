import { type } from "arktype";

import type { FakeOpenCloudOptions, FakeOpenCloudTask } from "#test/harness/fake-open-cloud.ts";

export const createTaskRequestSchema = type({
	script: "string",
	timeout: "string",
});
export const JSON_CONTENT_TYPE = "application/json";
export type BootProbeAnswer = "complete" | "stall";

export interface FakeOpenCloudServer {
	baseUrl: string;
	calls: Array<FakeOpenCloudCall>;
	queueAdds: Array<{ queue: string; value: Exclude<JSONValue, null> }>;
	queueDiscards: Array<{ id: string; queue: string }>;
	requests: Array<typeof createTaskRequestSchema.infer>;
	uploadCount: number;
}

/**
 * Mutable per-server state, threaded through every route handler. The
 * `counters` are read back by the returned server's `uploadCount` getter, so
 * they must stay one shared object rather than copied numbers.
 */
export interface FakeOpenCloudState {
	/**
	 * Filled in once the server is listening; the create route hands it out.
	 */
	baseUrl: string;
	/** Answers for the probes still to come, consumed in order. */
	bootProbes: Array<BootProbeAnswer>;
	calls: FakeOpenCloudServer["calls"];
	counters: { itemSeq: number; taskIndex: number; uploadCount: number };
	pollCounts: Map<string, number>;
	queueAdds: FakeOpenCloudServer["queueAdds"];
	queueDiscards: FakeOpenCloudServer["queueDiscards"];
	queues: Map<string, Array<QueuedItem>>;
	requests: FakeOpenCloudServer["requests"];
	submitFailures: NonNullable<FakeOpenCloudOptions["submitFailures"]>;
	taskQueue: Array<FakeOpenCloudTask>;
	taskResults: Map<string, FakeOpenCloudTask>;
	uploadConnectionResets: number;
}

interface FakeOpenCloudCall {
	apiKey: string | undefined;
	method: string;
	url: string;
}

interface QueuedItem {
	id: string;
	value: Exclude<JSONValue, null>;
}

export function createState(
	tasks: Array<FakeOpenCloudTask>,
	options: FakeOpenCloudOptions,
): FakeOpenCloudState {
	return {
		baseUrl: "",
		bootProbes: [...(options.bootProbes ?? [])],
		calls: [],
		counters: { itemSeq: 0, taskIndex: 0, uploadCount: 0 },
		pollCounts: new Map(),
		queueAdds: [],
		queueDiscards: [],
		queues: new Map(),
		requests: [],
		submitFailures: [...(options.submitFailures ?? [])],
		taskQueue: [...tasks],
		taskResults: new Map(),
		uploadConnectionResets: options.uploadConnectionResets ?? 0,
	};
}
