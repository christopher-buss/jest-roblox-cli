import { randomUUID } from "node:crypto";

import type { Backend, StreamingHooks } from "../backends/interface.ts";
import { type ExecuteResult, runProjectsAsync, type RunProjectsOptions } from "../executor.ts";
import { StreamingResultClient } from "../memory-store/sorted-map-client.ts";
import { prepareWorkStealingQueueAsync } from "../memory-store/work-stealing.ts";
import {
	StreamingAggregator,
	type StreamingAggregatorOnEntry,
} from "../reporter/streaming-aggregator.ts";
import {
	generateMaterializerScript,
	generateWorkStealingScript,
	type MaterializerInput,
} from "../staging/test-script-staged.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { PendingEntry } from "./test-selection.ts";

const PER_PACKAGE_TIMEOUT_SECONDS = 60;

export type WorkspaceDispatchSpec = Pick<
	RunProjectsOptions,
	"parallel" | "scriptFactory" | "scriptOverride" | "streaming" | "workStealing"
>;

interface WorkStealingCredentials {
	apiKey: string;
	baseUrl?: string;
	universeId: string;
}

interface WorkspaceDispatchInput {
	generateUuid?: (() => string) | undefined;
	onStreamingResult?: StreamingAggregatorOnEntry | undefined;
	parallel?: "auto" | number | undefined;
	pending: Array<PendingEntry>;
	placeFile: string;
	workStealingCredentials: undefined | WorkStealingCredentials;
}

interface WorkStealingDispatchInput {
	credentials: WorkStealingCredentials;
	generateUuid: () => string;
	inputs: Array<MaterializerInput>;
	onStreamingResult?: StreamingAggregatorOnEntry | undefined;
	parallel: number;
}

interface DispatchedProjectsInput {
	backend: Backend | undefined;
	dispatchSpec: WorkspaceDispatchSpec;
	pending: Array<PendingEntry>;
	placeFile: string;
	startTime: number;
	timing: TimingCollector;
	version: string;
}

/** Runs every pending (pkg, project) against the shared place. */
export async function runDispatchedProjectsAsync(
	input: DispatchedProjectsInput,
): Promise<Array<ExecuteResult>> {
	const { dispatchSpec, pending, placeFile, startTime, timing, version } = input;
	const { results } = await timing.profileAsync("runProjects", async () => {
		return runProjectsAsync({
			// Defined whenever runtime jobs exist: only `--typecheckOnly`
			// omits the backend, and that path short-circuits before
			// reaching any runtime dispatch.
			// eslint-disable-next-line ts/no-non-null-assertion -- backend present for runtime jobs
			backend: input.backend!,
			deferFormatting: true,
			projects: pending.map((entry) => {
				return {
					config: { ...entry.projectConfig, placeFile },
					displayColor: entry.project.displayColor,
					displayName: entry.project.displayName,
					pkg: entry.pkg,
					testFiles: entry.testFiles,
				};
			}),
			startTime,
			timing,
			version,
			...dispatchSpec,
		});
	});

	return results;
}

export async function prepareWorkspaceDispatchAsync(
	input: WorkspaceDispatchInput,
): Promise<WorkspaceDispatchSpec> {
	const { generateUuid, onStreamingResult, pending, placeFile, workStealingCredentials } = input;
	const inputs = buildMaterializerInputs(pending, placeFile);

	// `runOptions.parallel` already reflects CLI > per-package consensus >
	// default; `"auto"` does not enable work-stealing (parity with the
	// pre-existing CLI behavior — only an explicit count > 1 fans out).
	const parallel = typeof input.parallel === "number" ? input.parallel : undefined;
	const shouldUseWorkStealing =
		workStealingCredentials !== undefined && parallel !== undefined && parallel > 1;

	if (shouldUseWorkStealing) {
		return prepareStealingDispatchAsync({
			credentials: workStealingCredentials,
			generateUuid: generateUuid ?? randomUUID,
			inputs,
			onStreamingResult,
			parallel,
		});
	}

	// The factory lets the backend re-send only the entries a task left behind
	// when its return envelope filled up. Matched on (pkg, project), the same
	// pair the entries are keyed by.
	return {
		scriptFactory: (jobs) => {
			return generateMaterializerScript(
				inputs.filter((candidate) => {
					return jobs.some((job) => {
						return job.pkg === candidate.pkg && job.displayName === candidate.project;
					});
				}),
			);
		},
		scriptOverride: generateMaterializerScript(inputs),
	};
}

// The materializer payload: one entry per (pkg, project) runtime job, each
// pinned to the one synthesized place the whole workspace run shares.
function buildMaterializerInputs(
	pending: Array<PendingEntry>,
	placeFile: string,
): Array<MaterializerInput> {
	return pending.map((entry) => {
		return {
			config: { ...entry.projectConfig, placeFile },
			pkg: entry.pkg,
			project: entry.project.displayName,
			testFiles: entry.testFiles,
		};
	});
}

function buildStreaming(input: {
	credentials: WorkStealingCredentials;
	generateUuid: () => string;
	onStreamingResult: StreamingAggregatorOnEntry;
}): { hooks: StreamingHooks; sortedMapId: string } {
	const sortedMapId = input.generateUuid();
	// drain() is intentionally untouched in the current production path —
	// it's an in-memory buffer kept for future formatter integrations that
	// need to emit a final summary across all streamed entries (e.g. JSON
	// envelope with per-pkg summaries). Today the aggregator's sole job is
	// per-arrival dedupe + forwarding to onStreamingResult.
	const aggregator = new StreamingAggregator({ onEntry: input.onStreamingResult });
	const reader = new StreamingResultClient({
		...(input.credentials.baseUrl !== undefined ? { baseUrl: input.credentials.baseUrl } : {}),
		credentials: {
			apiKey: input.credentials.apiKey,
			universeId: input.credentials.universeId,
		},
		mapId: sortedMapId,
	});

	return {
		hooks: {
			onPackageResult: (entry) => {
				aggregator.accept(entry);
			},
			reader,
		},
		sortedMapId,
	};
}

async function prepareStealingDispatchAsync({
	credentials,
	generateUuid,
	inputs,
	onStreamingResult,
	parallel,
}: WorkStealingDispatchInput): Promise<WorkspaceDispatchSpec> {
	const { apiKey, baseUrl, universeId } = credentials;
	const prepared = await prepareWorkStealingQueueAsync({
		...(baseUrl !== undefined ? { baseUrl } : {}),
		credentials: { apiKey, universeId },
		packages: inputs.map((entry) => ({ pkg: entry.pkg, project: entry.project })),
		perPackageTimeoutSeconds: PER_PACKAGE_TIMEOUT_SECONDS,
	});

	// Gate streaming setup on an actual consumer. Without `onStreamingResult`
	// (JSON/agent/silent runs) the SortedMap polling has no sink — running
	// it anyway burns HTTP quota and risks the one-shot stderr warning
	// leaking into structured output. Skip the SortedMap path entirely;
	// the final batched envelope still drives per-package output files.
	const streaming =
		onStreamingResult !== undefined
			? buildStreaming({ credentials, generateUuid, onStreamingResult })
			: undefined;

	const script = generateWorkStealingScript(
		inputs,
		prepared.queueId,
		prepared.invisibilityWindowSeconds,
		streaming !== undefined ? { streaming: { sortedMapId: streaming.sortedMapId } } : {},
	);

	return {
		parallel,
		scriptOverride: script,
		...(streaming !== undefined ? { streaming: streaming.hooks } : {}),
		workStealing: true,
	};
}
