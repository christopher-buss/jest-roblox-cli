import { randomUUID } from "node:crypto";
import process from "node:process";

import type { Backend, StreamingHooks } from "../backends/interface.ts";
import { isShardedParallel } from "../backends/interface.ts";
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
import { errorMessage } from "../utils/error-message.ts";
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
	parallel: "auto" | number;
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

export async function prepareWorkspaceDispatchAsync({
	generateUuid,
	onStreamingResult,
	parallel,
	pending,
	placeFile,
	workStealingCredentials,
}: WorkspaceDispatchInput): Promise<WorkspaceDispatchSpec> {
	const inputs = buildMaterializerInputs(pending, placeFile);

	// `runOptions.parallel` already reflects CLI > per-package consensus >
	// default. `"auto"` counts as sharded here exactly as it does everywhere
	// else (`isShardedParallel`, which the studio-cli serial check uses) and is
	// forwarded unresolved — the backend turns it into a task count against the
	// job total, the same arithmetic multi's static bucketing does.
	if (workStealingCredentials !== undefined && isShardedParallel(parallel)) {
		const stealing = await tryStealingDispatchAsync({
			credentials: workStealingCredentials,
			generateUuid: generateUuid ?? randomUUID,
			inputs,
			onStreamingResult,
			parallel,
		});
		if (stealing !== undefined) {
			return stealing;
		}
	}

	return deferrableDispatch(inputs);
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

	// Gate streaming setup on an actual consumer. Without `onStreamingResult`
	// (JSON/agent/silent runs) the SortedMap polling has no sink — running
	// it anyway burns HTTP quota and risks the one-shot stderr warning
	// leaking into structured output. Skip the SortedMap path entirely;
	// the final batched envelope still drives per-package output files.
	const streaming =
		onStreamingResult !== undefined
			? buildStreaming({ credentials, generateUuid, onStreamingResult })
			: undefined;

	// Enqueued last, so nothing after this point can throw and strand the
	// items: a caller that falls back to the sequential path would otherwise
	// leave a full queue behind until its ten-minute TTL expires.
	const prepared = await prepareWorkStealingQueueAsync({
		...(baseUrl !== undefined ? { baseUrl } : {}),
		credentials: { apiKey, universeId },
		packages: inputs.map((entry) => ({ pkg: entry.pkg, project: entry.project })),
		perPackageTimeoutSeconds: PER_PACKAGE_TIMEOUT_SECONDS,
	});

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

/**
 * Build the work-stealing spec, or report `undefined` when the queue could not
 * be set up.
 *
 * The queue needs `memory-store.queue:*` on the API key, which the scopes for
 * an ordinary run do not include — so a key that has always worked starts
 * failing the moment `"auto"` begins to shard. A run that still produces
 * correct results serially is a better answer than a hard failure, so degrade
 * and say why: any queue error lands here, because whatever went wrong
 * (missing scope, network, quota) the sequential path is still available and
 * still right.
 */
async function tryStealingDispatchAsync(
	input: WorkStealingDispatchInput,
): Promise<undefined | WorkspaceDispatchSpec> {
	try {
		return await prepareStealingDispatchAsync(input);
	} catch (err) {
		process.stderr.write(
			"Warning: could not set up the work-stealing queue, running packages " +
				`one task at a time: ${errorMessage(err)}\n` +
				"Grant the API key memory-store.queue:add/dequeue/discard to run " +
				"them in parallel.\n",
		);
		return undefined;
	}
}

/**
 * One script carrying every entry, plus a factory the backend uses to re-send
 * only the entries a task left behind when its return envelope filled up.
 * Matched on (pkg, project), the same pair the entries are keyed by.
 */
function deferrableDispatch(inputs: Array<MaterializerInput>): WorkspaceDispatchSpec {
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
