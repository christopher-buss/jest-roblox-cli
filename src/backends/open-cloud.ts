import { PermissionError } from "@bedrock-rbx/ocale";
import { OcaleRunner } from "@isentinel/roblox-runner";
import type { RemoteRunner, RunnerCredentials } from "@isentinel/roblox-runner";

import * as path from "node:path";
import process from "node:process";

import type { ResolvedConfig } from "../config/schema.ts";
import { generateTestScript, type JestArgvInput } from "../test-script.ts";
import { parseEnvelope } from "./envelope.ts";
import type {
	Backend,
	BackendOptions,
	BackendResult,
	EnvelopeEntry,
	ProjectJob,
	RawBackendEntry,
	StreamingHooks,
} from "./interface.ts";

const PARALLEL_AUTO_CAP = 3;
const BASE_URL_ENV = "JEST_ROBLOX_OPEN_CLOUD_BASE_URL";
const DEFAULT_STREAM_POLL_MS = 250;

export type OpenCloudCredentials = RunnerCredentials;

export interface OpenCloudOptions {
	/**
	 * Inject a pre-built {@link RemoteRunner}. When provided, the
	 * `credentials` argument to {@link OpenCloudBackend} is ignored —
	 * the injected runner already owns its own credentials. Intended
	 * primarily as a test seam.
	 */
	runner?: RemoteRunner;
}

interface JobBucket {
	indices: Array<number>;
	jobs: Array<ProjectJob>;
}

interface PollState {
	warned: boolean;
}

export class OpenCloudBackend implements Backend {
	private readonly runner: RemoteRunner;

	public readonly kind = "open-cloud" as const;

	constructor(credentials: OpenCloudCredentials, options?: OpenCloudOptions) {
		this.runner = options?.runner ?? new OcaleRunner(credentials, resolveRunnerOptions());
	}

	public async runTests(options: BackendOptions): Promise<BackendResult> {
		const { jobs, parallel, scriptOverride, streaming, workStealing } = options;
		if (jobs.length === 0) {
			throw new Error("OpenCloudBackend requires at least one job");
		}

		if (workStealing === true && scriptOverride === undefined) {
			throw new Error("OpenCloudBackend work-stealing mode requires scriptOverride");
		}

		// timeout is picked from the first job — it's a per-run knob.
		// eslint-disable-next-line ts/no-non-null-assertion -- length checked above
		const primary = jobs[0]!;
		const placeFilePath = path.resolve(primary.config.rootDir, primary.config.placeFile);

		const upload = await this.runner.uploadPlace({ placeFilePath });

		const executionStart = Date.now();
		const flattened =
			workStealing === true
				? await this.runWorkStealing({
						jobs,
						parallel,
						primaryConfig: primary.config,
						// eslint-disable-next-line ts/no-non-null-assertion -- length checked above
						scriptOverride: scriptOverride!,
						streaming,
					})
				: await this.runStaticBuckets(jobs, parallel, scriptOverride);
		const executionMs = Date.now() - executionStart;

		return {
			rawResults: flattened,
			timing: { executionMs, uploadMs: upload.uploadMs },
		};
	}

	private async runBucket(
		bucket: JobBucket,
		scriptOverride?: string,
	): Promise<{ indices: Array<number>; rawResults: Array<RawBackendEntry> }> {
		const { indices, jobs } = bucket;
		// A bucket is only created for at least one job, so jobs[0] is defined.
		// eslint-disable-next-line ts/no-non-null-assertion -- bucket non-empty
		const primary = jobs[0]!;
		const inputs: Array<JestArgvInput> = jobs.map((job) => {
			return { config: job.config, testFiles: job.testFiles };
		});

		const script = scriptOverride ?? generateTestScript(inputs);
		const scriptResult = await this.runner.executeScript({
			script,
			timeout: primary.config.timeout,
		});

		const jestOutput = scriptResult.outputs[0];
		if (jestOutput === undefined) {
			throw new Error(
				`No test results in output. Got: ${JSON.stringify(scriptResult.outputs)}`,
			);
		}

		const fallbackGameOutput = scriptResult.outputs[1];
		const entries = parseEnvelope(jestOutput);
		if (entries.length !== jobs.length) {
			throw new Error(
				`Open Cloud backend returned ${entries.length.toString()} entries but bucket had ${jobs.length.toString()} jobs`,
			);
		}

		const rawResults: Array<RawBackendEntry> = entries.map((entry) => {
			return { entry, fallbackGameOutput };
		});

		return { indices, rawResults };
	}

	private async runStaticBuckets(
		jobs: Array<ProjectJob>,
		parallel: BackendOptions["parallel"],
		scriptOverride?: string,
	): Promise<Array<RawBackendEntry>> {
		const buckets = bucketJobs(jobs, parallel);
		const bucketResults = await Promise.all(
			buckets.map(async (bucket) => this.runBucket(bucket, scriptOverride)),
		);

		// Flatten bucket results in original job order via the indices recorded
		// at bucketing time. indices and rawResults always share the same length
		// because runBucket asserts that invariant before returning.
		const flattened: Array<RawBackendEntry> = Array.from({ length: jobs.length });
		for (const { indices, rawResults } of bucketResults) {
			for (const [positionInBucket, originalIndex] of indices.entries()) {
				// eslint-disable-next-line ts/no-non-null-assertion -- length invariant
				flattened[originalIndex] = rawResults[positionInBucket]!;
			}
		}

		return flattened;
	}

	private async runStealingTask(
		script: string,
		primaryConfig: ResolvedConfig,
	): Promise<{ entries: Array<EnvelopeEntry>; gameOutput: string | undefined }> {
		const result = await this.runner.executeScript({
			script,
			timeout: primaryConfig.timeout,
		});

		const jestOutput = result.outputs[0];
		if (jestOutput === undefined) {
			throw new Error(`No test results in output. Got: ${JSON.stringify(result.outputs)}`);
		}

		return { entries: parseEnvelope(jestOutput), gameOutput: result.outputs[1] };
	}

	private async runWorkStealing(args: {
		jobs: Array<ProjectJob>;
		parallel: BackendOptions["parallel"];
		primaryConfig: ResolvedConfig;
		scriptOverride: string;
		streaming: StreamingHooks | undefined;
	}): Promise<Array<RawBackendEntry>> {
		const { jobs, parallel, primaryConfig, scriptOverride, streaming } = args;
		const taskCount = resolveBucketCount(parallel, jobs.length);
		const tasksDone = { value: false };
		const taskEnvelopesPromise = Promise.all(
			Array.from({ length: taskCount }, async () =>
				this.runStealingTask(scriptOverride, primaryConfig),
			),
		).finally(() => {
			tasksDone.value = true;
		});

		const pollPromise =
			streaming !== undefined
				? pollStreamingResults(streaming, () => tasksDone.value)
				: Promise.resolve();

		// Settle both promises before letting any task failure escape: tasksDone
		// is set by taskEnvelopesPromise.finally regardless of success/failure,
		// so pollPromise terminates within ~pollMs of the task settling. If we
		// went through `await Promise.all([...])` and the task rejected,
		// pollPromise would be orphaned — its setTimeout chain could keep timers
		// alive and write to stderr after the function has already returned.
		const [taskSettlement] = await Promise.allSettled([taskEnvelopesPromise, pollPromise]);
		if (taskSettlement.status === "rejected") {
			throw taskSettlement.reason;
		}

		const taskEnvelopes = taskSettlement.value;
		const entryByKey = aggregateEntriesByKey(taskEnvelopes);

		const missing: Array<string> = [];
		const rawResults: Array<RawBackendEntry> = [];
		for (const job of jobs) {
			const found = entryByKey.get(
				entryLookupKey(job.pkg ?? job.displayName, job.displayName),
			);
			if (found === undefined) {
				missing.push(job.displayName);
				continue;
			}

			rawResults.push({ entry: found.entry, fallbackGameOutput: found.gameOutput });
		}

		if (missing.length > 0) {
			throw new Error(
				`Open Cloud work-stealing returned no entries for ${missing.length.toString()} package(s): ${missing.join(", ")}`,
			);
		}

		return rawResults;
	}
}

/**
 * Poll the streaming SortedMap until `isDone()` returns true, then perform
 * one final drain. Each newly-observed entry is forwarded to
 * `onPackageResult` and deleted from the map. Errors are swallowed so a
 * transient HTTP failure doesn't take down the test run — the final task
 * envelope still carries authoritative results.
 */
export async function pollStreamingResults(
	hooks: StreamingHooks,
	isDone: () => boolean,
): Promise<void> {
	const pollMs = hooks.pollMs ?? DEFAULT_STREAM_POLL_MS;
	const state: PollState = { warned: false };

	while (!isDone()) {
		await drainOnce(hooks, state);
		await sleep(pollMs);
	}

	// Final pass to catch any entries written between the last drain and
	// tasksDone.
	await drainOnce(hooks, state);
}

export function resolveOpenCloudBaseUrl(): string | undefined {
	const override = process.env[BASE_URL_ENV]?.trim();
	if (override === undefined || override === "") {
		return undefined;
	}

	return override.replace(/\/+$/, "");
}

export function createOpenCloudBackend(credentials: OpenCloudCredentials): OpenCloudBackend {
	return new OpenCloudBackend(credentials);
}

function describeError(err: unknown): string {
	const cause = err instanceof Error ? err.cause : undefined;
	if (cause instanceof PermissionError) {
		const scopes = cause.requiredScopes.join(", ");
		return `API key missing scope${cause.requiredScopes.length === 1 ? "" : "s"} ${scopes}. Add via Creator Dashboard.`;
	}

	return err instanceof Error ? err.message : String(err);
}

function warnStreamingDisabled(err: unknown, state: PollState): void {
	if (state.warned) {
		return;
	}

	state.warned = true;
	process.stderr.write(`Warning: live per-package streaming disabled — ${describeError(err)}\n`);
	process.stderr.write("  Tests still run; results print as usual once each task finishes.\n");
}

async function drainOnce(hooks: StreamingHooks, state: PollState): Promise<void> {
	let records;
	try {
		records = await hooks.reader.readAll();
	} catch (err) {
		warnStreamingDisabled(err, state);
		return;
	}

	// Forward in arrival order so the streaming-progress lines stay
	// deterministic, then fire deletes in parallel — when several packages
	// land between two poll ticks, serial deletes can stack up to a full
	// poll interval of latency before the next read sees fresh entries.
	for (const record of records) {
		hooks.onPackageResult(record.value);
	}

	await Promise.all(
		records.map(async (record) => {
			try {
				await hooks.reader.delete(record.id);
			} catch (err) {
				// Best-effort; if delete fails the entry will reappear on the
				// next poll and onPackageResult dedupes downstream. Still surface
				// the first failure so users know their key can read but not
				// write.
				warnStreamingDisabled(err, state);
			}
		}),
	);
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function resolveRunnerOptions(): { baseUrl?: string } {
	const baseUrl = resolveOpenCloudBaseUrl();
	return baseUrl === undefined ? {} : { baseUrl };
}

function resolveBucketCount(parallel: BackendOptions["parallel"], jobCount: number): number {
	if (parallel === undefined) {
		return 1;
	}

	if (parallel === "auto") {
		return Math.min(jobCount, PARALLEL_AUTO_CAP);
	}

	if (parallel < 1) {
		throw new Error(`--parallel must be >= 1, got ${parallel.toString()}`);
	}

	return Math.min(Math.floor(parallel), jobCount);
}

function bucketJobs(
	jobs: Array<ProjectJob>,
	parallel: BackendOptions["parallel"],
): Array<JobBucket> {
	const bucketCount = resolveBucketCount(parallel, jobs.length);
	const buckets: Array<JobBucket> = [];
	for (let index = 0; index < bucketCount; index++) {
		buckets.push({ indices: [], jobs: [] });
	}

	// Round-robin assignment: job[i] goes to bucket i % bucketCount. Preserves
	// input order within each bucket so per-bucket results flatten back in the
	// original request order via the recorded indices. Smart LPT bucketing is
	// future work (F1 in the plan).
	for (const [originalIndex, job] of jobs.entries()) {
		// eslint-disable-next-line ts/no-non-null-assertion -- index always valid
		const bucket = buckets[originalIndex % bucketCount]!;
		bucket.indices.push(originalIndex);
		bucket.jobs.push(job);
	}

	return buckets;
}

function entryLookupKey(package_: string, project: string | undefined): string {
	return project === undefined || project === package_ ? package_ : `${package_}::${project}`;
}

// Aggregate entries from all task envelopes. Map by pkg::project so
// multi-project packages don't collide on a shared `pkg`. The first
// observed entry per key wins; subsequent duplicates (from fault-
// recovery re-runs after invisibility timeout) are dropped.
function aggregateEntriesByKey(
	taskEnvelopes: ReadonlyArray<{ entries: Array<EnvelopeEntry>; gameOutput: string | undefined }>,
): Map<string, { entry: EnvelopeEntry; gameOutput: string | undefined }> {
	const entryByKey = new Map<string, { entry: EnvelopeEntry; gameOutput: string | undefined }>();
	for (const { entries, gameOutput } of taskEnvelopes) {
		for (const entry of entries) {
			if (entry.pkg !== undefined) {
				const key = entryLookupKey(entry.pkg, entry.project);
				if (!entryByKey.has(key)) {
					entryByKey.set(key, { entry, gameOutput });
				}
			}
		}
	}

	return entryByKey;
}
