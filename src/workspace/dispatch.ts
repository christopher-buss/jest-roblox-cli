import { randomUUID } from "node:crypto";
import process from "node:process";

import type { Backend, ParallelOption, ProjectJob, StreamingHooks } from "../backends/interface.ts";
import { isShardedParallel } from "../backends/interface.ts";
import {
	buildProjectJob,
	type ExecuteResult,
	runProjectsAsync,
	type RunProjectsOptions,
} from "../executor.ts";
import type { TsconfigMappingCache } from "../executor/tsconfig-mappings.ts";
import { StreamingResultClient } from "../memory-store/sorted-map-client.ts";
import {
	type PreparedWorkStealing,
	prepareWorkStealingQueueAsync,
} from "../memory-store/work-stealing.ts";
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

export type WorkspaceDispatchSpec = Pick<
	RunProjectsOptions,
	| "parallel"
	| "scriptFactory"
	| "scriptOverride"
	| "streaming"
	| "testProgressMapId"
	| "workStealing"
>;

/**
 * A dispatch job carrying the package it belongs to. `ProjectJob.pkg` is
 * optional because multi mode has no packages; every workspace job has one,
 * and the materializer payload keys its entries by it.
 */
export interface WorkspaceJob extends ProjectJob {
	pkg: string;
}

interface WorkStealingCredentials {
	apiKey: string;
	baseUrl?: string | undefined;
	universeId: string;
}

interface WorkspaceDispatchInput {
	/** Stop the run on the first failing package (`--bail`). */
	bail?: boolean | undefined;
	generateUuid?: (() => string) | undefined;
	jobs: Array<WorkspaceJob>;
	onStreamingResult?: StreamingAggregatorOnEntry | undefined;
	parallel?: ParallelOption;
	/**
	 * The run's progress map, resolved once from the backend by the caller so
	 * both dispatch modes decide it the same way. Baked into every script this
	 * dispatch builds, because the backend never sees one it did not generate.
	 */
	testProgressMapId?: string | undefined;
	workStealingCredentials: undefined | WorkStealingCredentials;
}

interface WorkStealingDispatchInput {
	bail: boolean;
	credentials: WorkStealingCredentials;
	generateUuid: () => string;
	inputs: Array<MaterializerInput>;
	onStreamingResult?: StreamingAggregatorOnEntry | undefined;
	parallel: "auto" | number;
	testProgressMapId: string | undefined;
}

interface DispatchedProjectsInput {
	backend: Backend | undefined;
	dispatchSpec: WorkspaceDispatchSpec;
	jobs: Array<WorkspaceJob>;
	startTime: number;
	timing: TimingCollector;
	tsconfigCache: TsconfigMappingCache;
	version: string;
}

interface BuildStreamingResult {
	hooks: StreamingHooks;
	sortedMapId: string;
}

/**
 * Runs every dispatch job against the shared place.
 *
 * The jobs handed in are the ones the dispatched script was built from, so the
 * run and the runtime agree on every project's config by identity rather than
 * by resolving it a second time.
 */
export async function runDispatchedProjectsAsync(
	input: DispatchedProjectsInput,
): Promise<{ ranProjectIndices: Array<number>; results: Array<ExecuteResult> }> {
	const { dispatchSpec, jobs, startTime, timing, tsconfigCache, version } = input;
	const { ranProjectIndices, results } = await timing.profileAsync("runProjects", async () => {
		return runProjectsAsync({
			// Defined whenever runtime jobs exist: only `--typecheckOnly`
			// omits the backend, and that path short-circuits before
			// reaching any runtime dispatch.
			// eslint-disable-next-line ts/no-non-null-assertion -- backend present for runtime jobs
			backend: input.backend!,
			deferFormatting: true,
			projects: jobs,
			startTime,
			timing,
			tsconfigCache,
			version,
			...dispatchSpec,
		});
	});

	return { ranProjectIndices, results };
}

/**
 * Resolve every pending (pkg, project) into the job it dispatches as, pinned to
 * the one synthesized place the whole workspace run shares.
 *
 * The run builds these once and hands the same array to both the script build
 * and the run itself, so the two cannot disagree about a project's config. The
 * `tsconfigCache` travels with them for the same reason: passed on to
 * `runProjectsAsync`, it keeps result post-processing on the scan taken here.
 */
export function buildWorkspaceJobs(
	pending: Array<PendingEntry>,
	placeFile: string,
	tsconfigCache: TsconfigMappingCache,
): Array<WorkspaceJob> {
	return pending.map((entry) => {
		const job = buildProjectJob(
			{
				config: { ...entry.projectConfig, placeFile },
				displayColor: entry.project.displayColor,
				displayName: entry.project.displayName,
				pkg: entry.pkg,
				testFiles: entry.testFiles,
			},
			tsconfigCache,
		);

		return { ...job, pkg: entry.pkg };
	});
}

export async function prepareWorkspaceDispatchAsync({
	bail = false,
	generateUuid = randomUUID,
	jobs,
	onStreamingResult,
	parallel,
	testProgressMapId,
	workStealingCredentials,
}: WorkspaceDispatchInput): Promise<WorkspaceDispatchSpec> {
	const inputs = buildMaterializerInputs(jobs);

	// `runOptions.parallel` already reflects CLI > per-package consensus >
	// default. Only Open Cloud reaches this branch (work-stealing credentials
	// resolve nowhere else), so `"auto"` counts as sharded and is forwarded
	// unresolved — the backend turns it into a task count against the job
	// total, the same arithmetic multi's static bucketing does. A serial
	// backend reads the same `"auto"` as one session; `isExplicitMultiShard`
	// is the predicate that guards those.
	if (workStealingCredentials !== undefined && isShardedParallel(parallel)) {
		const stealing = await tryStealingDispatchAsync({
			bail,
			credentials: workStealingCredentials,
			generateUuid,
			inputs,
			onStreamingResult,
			parallel,
			testProgressMapId,
		});
		if (stealing !== undefined) {
			return stealing;
		}
	}

	return deferrableDispatch({ bail, inputs, testProgressMapId });
}

/**
 * The longest any one package in the batch may run, in the seconds the queue
 * measures its invisibility window in.
 *
 * A package with no budget of its own is bounded only by the deadline Roblox
 * gives the whole task, so that is what a sibling has to wait out before
 * reclaiming its queue item. Taking the slowest is what keeps a fast package
 * from setting the window for a slow one: reclaiming an item still being
 * worked on runs it twice.
 *
 * That deadline is the first job's `timeout` for every package in the batch,
 * not each package's own — the backend resolves one run timeout from `jobs[0]`
 * and gives every work-stealing task the same one. Reading a later package's
 * `timeout` instead sizes the window under the deadline its item is actually
 * worked on under, which is the double-run this window exists to prevent. It
 * bounds an explicit budget for the same reason: Roblox ends the task first, so
 * waiting past it only delays reclaiming an item whose worker is already gone.
 */
function longestPackageSeconds(inputs: ReadonlyArray<MaterializerInput>): number {
	let longestMs = 0;
	for (const { config } of inputs) {
		// Read here rather than above the loop because this is where the batch
		// is known to have a first entry: an empty one never reaches the body,
		// and answers with the zero below rather than with a deadline.
		// eslint-disable-next-line ts/no-non-null-assertion -- non-empty inside its own loop
		const taskDeadlineMs = inputs[0]!.config.timeout;
		longestMs = Math.max(
			longestMs,
			config.projectTimeout > 0
				? Math.min(config.projectTimeout, taskDeadlineMs)
				: taskDeadlineMs,
		);
	}

	return Math.ceil(longestMs / 1000);
}

function buildStreaming(input: {
	credentials: WorkStealingCredentials;
	generateUuid: () => string;
	onStreamingResult: StreamingAggregatorOnEntry;
}): BuildStreamingResult {
	const sortedMapId = input.generateUuid();
	// drain() is intentionally untouched in the current production path —
	// it's an in-memory buffer kept for future formatter integrations that
	// need to emit a final summary across all streamed entries (e.g. JSON
	// envelope with per-pkg summaries). Today the aggregator's sole job is
	// per-arrival dedupe + forwarding to onStreamingResult.
	const aggregator = new StreamingAggregator({ onEntry: input.onStreamingResult });
	const reader = new StreamingResultClient({
		baseUrl: input.credentials.baseUrl,
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

/** The one script every worker on this run's queue boots into. */
function buildStealingScript({
	bail,
	generateUuid,
	inputs,
	prepared,
	streaming,
	testProgressMapId,
}: {
	bail: boolean;
	generateUuid: () => string;
	inputs: ReadonlyArray<MaterializerInput>;
	prepared: PreparedWorkStealing;
	streaming: BuildStreamingResult | undefined;
	testProgressMapId: string | undefined;
}): string {
	return generateWorkStealingScript(
		inputs,
		prepared.queueId,
		prepared.invisibilityWindowSeconds,
		{
			bail,
			// Its own map rather than a reserved key in the results map: the
			// CLI polls that one and would have to decode past the signal, and
			// a bail without a streaming consumer would publish per-package
			// summaries nobody drains just to keep the channel open.
			...(bail ? { bailMapId: generateUuid() } : {}),
			queueTtlSeconds: prepared.ttlSeconds,
			...(streaming === undefined
				? {}
				: { streaming: { sortedMapId: streaming.sortedMapId } }),
			testProgressMapId,
		},
	);
}

async function prepareStealingDispatchAsync({
	bail,
	credentials,
	generateUuid,
	inputs,
	onStreamingResult,
	parallel,
	testProgressMapId,
}: WorkStealingDispatchInput): Promise<WorkspaceDispatchSpec> {
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
		baseUrl: credentials.baseUrl,
		credentials: { apiKey: credentials.apiKey, universeId: credentials.universeId },
		packages: inputs.map((entry) => ({ pkg: entry.pkg, project: entry.project })),
		perPackageTimeoutSeconds: longestPackageSeconds(inputs),
	});

	const script = buildStealingScript({
		bail,
		generateUuid,
		inputs,
		prepared,
		streaming,
		testProgressMapId,
	});

	return {
		parallel,
		scriptOverride: script,
		...(streaming === undefined ? {} : { streaming: streaming.hooks }),
		testProgressMapId,
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
function deferrableDispatch({
	bail,
	inputs,
	testProgressMapId,
}: {
	bail: boolean;
	inputs: Array<MaterializerInput>;
	testProgressMapId: string | undefined;
}): WorkspaceDispatchSpec {
	// One map for every script this dispatch builds, the re-sends included: a
	// task that answers a deferral is the same run continuing, and the host
	// reads the map once for all of them.
	const options = { bail, testProgressMapId };

	return {
		scriptFactory: (jobs) => {
			return generateMaterializerScript(
				inputs.filter((candidate) => {
					return jobs.some((job) => {
						return job.pkg === candidate.pkg && job.displayName === candidate.project;
					});
				}),
				options,
			);
		},
		scriptOverride: generateMaterializerScript(inputs, options),
		testProgressMapId,
	};
}

// The materializer payload: one entry per (pkg, project) runtime job. It
// carries the job's resolved config, because this script is frozen here —
// anything resolved after it is built reaches multi mode only.
function buildMaterializerInputs(jobs: Array<WorkspaceJob>): Array<MaterializerInput> {
	return jobs.map((job) => {
		return {
			config: job.config,
			pkg: job.pkg,
			project: job.displayName,
			testFiles: job.testFiles,
		};
	});
}
