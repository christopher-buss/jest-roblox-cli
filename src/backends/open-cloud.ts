import { PermissionError } from "@bedrock-rbx/ocale";
import { OcaleRunner, runTaskPool } from "@isentinel/roblox-runner";
import type { RemoteRunner, RunnerCredentials, ScriptResult } from "@isentinel/roblox-runner";

import process from "node:process";

import type { ResolvedConfig } from "../config/schema.ts";
import { resolvePlaceFilePath } from "../config/schema.ts";
import { generateTestScript, type JestArgvInput } from "../test-script.ts";
import { formatMissingScopes } from "../utils/error-chain.ts";
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

/**
 * The value the version guard returns when the booted server is not running
 * the version this run uploaded — i.e. a concurrent upload won the boot race.
 * The backend retries that task once, pinned to the uploaded version.
 *
 * Embedded verbatim in a Luau double-quoted string literal, so it must not
 * contain backslashes, double quotes, or newlines.
 */
export const PLACE_VERSION_RACE_SENTINEL = "__JEST_ROBLOX_PLACE_VERSION_RACE__";

const PARALLEL_AUTO_CAP = 3;
const BASE_URL_ENV = "JEST_ROBLOX_OPEN_CLOUD_BASE_URL";
const MAX_RETRIES_ENV = "JEST_ROBLOX_OCALE_MAX_RETRIES";
const DEFAULT_STREAM_POLL_MS = 250;
const TrailingSlashesPattern = /\/+$/;

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

	/** One-shot per run so parallel raced tasks don't repeat the warning. */
	private raceWarned = false;

	public readonly kind = "open-cloud" as const;

	constructor(credentials: OpenCloudCredentials, options?: OpenCloudOptions) {
		this.runner = options?.runner ?? new OcaleRunner(credentials, resolveRunnerOptions());
	}

	public async runTests(options: BackendOptions): Promise<BackendResult> {
		this.raceWarned = false;
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
		const placeFilePath = resolvePlaceFilePath(primary.config);

		const upload = await this.runner.uploadPlace({ placeFilePath });

		const executionStart = Date.now();
		const flattened =
			workStealing === true
				? await this.runWorkStealing({
						jobs,
						parallel,
						placeVersion: upload.versionNumber,
						primaryConfig: primary.config,
						// eslint-disable-next-line ts/no-non-null-assertion -- length checked above
						scriptOverride: scriptOverride!,
						streaming,
					})
				: await this.runStaticBuckets(jobs, parallel, upload.versionNumber, scriptOverride);
		const executionMs = Date.now() - executionStart;

		return {
			rawResults: flattened,
			timing: { executionMs, uploadMs: upload.uploadMs },
		};
	}

	/**
	 * Optimistic version pinning. Pinned tasks
	 * (`/versions/{v}/luau-execution-session-tasks`) miss the warm-server pool
	 * whenever no server holds the freshly-uploaded version yet, costing a cold
	 * place boot per task (~10-45s, scaling with place size). Unpinned tasks
	 * boot the latest saved version from the warm pool, so the first attempt
	 * runs unpinned with a guard prepended: if the booted server is not on this
	 * run's version (a concurrent upload won the boot race), the task returns
	 * {@link PLACE_VERSION_RACE_SENTINEL} instead of running. On the sentinel,
	 * the task is retried once, pinned — correct by construction, no re-upload
	 * (the version exists even when it is no longer head), and no unpinned
	 * retry loop for a concurrent uploader to keep winning against.
	 */
	private async executeGuarded(options: {
		placeVersion: number;
		script: string;
		timeout: number;
	}): Promise<ScriptResult> {
		const { placeVersion, script, timeout } = options;
		const guarded = injectVersionGuard(script, placeVersion);
		const first = await this.runner.executeScript({ script: guarded, timeout });
		if (first.outputs[0] !== PLACE_VERSION_RACE_SENTINEL) {
			return first;
		}

		if (!this.raceWarned) {
			this.raceWarned = true;
			process.stderr.write(
				"Warning: place version raced by a concurrent upload — raced tasks retried pinned (slower, cold place boot).\n",
			);
		}

		return this.runner.executeScript({ placeVersion, script, timeout });
	}

	private async runBucket(
		bucket: JobBucket,
		placeVersion: number,
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
		const scriptResult = await this.executeGuarded({
			placeVersion,
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
		placeVersion: number,
		scriptOverride?: string,
	): Promise<Array<RawBackendEntry>> {
		const buckets = bucketJobs(jobs, parallel);
		const bucketResults = await Promise.all(
			buckets.map(async (bucket) => this.runBucket(bucket, placeVersion, scriptOverride)),
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

	private async runWorkStealing(args: {
		jobs: Array<ProjectJob>;
		parallel: BackendOptions["parallel"];
		placeVersion: number;
		primaryConfig: ResolvedConfig;
		scriptOverride: string;
		streaming: StreamingHooks | undefined;
	}): Promise<Array<RawBackendEntry>> {
		const { jobs, parallel, placeVersion, primaryConfig, scriptOverride, streaming } = args;
		const taskCount = resolveBucketCount(parallel, jobs.length);

		// Drive the fixed task set through the shared roblox-runner pool. jest's
		// work is single-wave — the queue is enqueued upstream and each task
		// drains it until empty — so once `taskCount` tasks have launched the
		// known set is covered. Gating `isDone` on the launch count is the
		// "no-op replenishment": when a task returns its slot is never refilled,
		// so the pool fires exactly `taskCount` tasks and behaves like the old
		// `Promise.all` wave while reusing one orchestration path.
		const tasksDone = { value: false };
		const taskResults: Array<ScriptResult> = [];
		let launched = 0;
		let taskFailure: undefined | { error: unknown };
		const poolPromise = runTaskPool({
			concurrency: taskCount,
			isDone: () => launched >= taskCount,
			onError: (error) => {
				// The pool folds a task failure into a freed slot and resolves,
				// so without this the failure would be masked whenever a sibling
				// task drains the whole queue and covers every package. Capture
				// it and rethrow once the pool settles so an infrastructure or
				// script failure always fails the run, as the old `Promise.all`
				// wave did.
				taskFailure = { error };
			},
			onResult: (result) => {
				taskResults.push(result);
			},
			places: [
				{
					runTask: async () => {
						launched += 1;
						return this.executeGuarded({
							placeVersion,
							script: scriptOverride,
							timeout: primaryConfig.timeout,
						});
					},
				},
			],
		}).finally(() => {
			tasksDone.value = true;
		});

		const pollPromise =
			streaming !== undefined
				? pollStreamingResults(streaming, () => tasksDone.value)
				: Promise.resolve();

		// The pool never rejects (it folds task errors into freed slots) and its
		// `.finally` always flips tasksDone, so pollPromise terminates within
		// ~pollMs — neither promise orphans the other.
		await Promise.all([poolPromise, pollPromise]);

		if (taskFailure !== undefined) {
			throw taskFailure.error;
		}

		// Parse after the pool settles so a task that returned no usable output
		// throws here, in the normal flow, rather than being swallowed by the
		// pool's per-task error handling.
		const taskEnvelopes = taskResults.map(parseStealingEnvelope);
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

	return override.replace(TrailingSlashesPattern, "");
}

/**
 * Reads {@link MAX_RETRIES_ENV} for an Open Cloud retry-budget override. Lets
 * the live e2e suite raise the per-request retry count so concurrent place
 * uploads (which share one per-minute quota across processes) ride out a
 * transient 429 instead of failing. Returns undefined for unset, empty, or
 * non-integer values so the client keeps its own default.
 */
export function resolveOcaleMaxRetries(): number | undefined {
	const raw = process.env[MAX_RETRIES_ENV]?.trim();
	if (raw === undefined || raw === "") {
		return undefined;
	}

	// Number() (not parseInt) so partial/decimal strings like "8abc" or "8.5"
	// reject instead of silently truncating to 8.
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function createOpenCloudBackend(credentials: OpenCloudCredentials): OpenCloudBackend {
	return new OpenCloudBackend(credentials);
}

function describeError(err: unknown): string {
	const cause = err instanceof Error ? err.cause : undefined;
	if (cause instanceof PermissionError) {
		return formatMissingScopes(cause.requiredScopes);
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

/**
 * Insert the version guard after any leading `--!` directive lines — Luau
 * honors directives only in the leading comment block, so a plain line-1
 * prepend would silently disable a caller's `--!strict`/`--!native`/etc.
 */
function injectVersionGuard(script: string, placeVersion: number): string {
	const guard = `if game.PlaceVersion ~= ${String(placeVersion)} then return "${PLACE_VERSION_RACE_SENTINEL}" end`;
	const lines = script.split("\n");
	let insertAt = 0;
	for (const line of lines) {
		if (!line.startsWith("--!")) {
			break;
		}

		insertAt += 1;
	}

	lines.splice(insertAt, 0, guard);
	return lines.join("\n");
}

function resolveRunnerOptions(): { baseUrl?: string; maxRetries?: number } {
	const baseUrl = resolveOpenCloudBaseUrl();
	const maxRetries = resolveOcaleMaxRetries();
	return {
		...(baseUrl === undefined ? {} : { baseUrl }),
		...(maxRetries === undefined ? {} : { maxRetries }),
	};
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

/**
 * Decode one work-stealing task's return envelope. Throws when the task
 * produced no Jest output so a broken task surfaces as a run failure rather
 * than a silently-missing package.
 */
function parseStealingEnvelope(result: ScriptResult): {
	entries: Array<EnvelopeEntry>;
	gameOutput: string | undefined;
} {
	const jestOutput = result.outputs[0];
	if (jestOutput === undefined) {
		throw new Error(`No test results in output. Got: ${JSON.stringify(result.outputs)}`);
	}

	return { entries: parseEnvelope(jestOutput), gameOutput: result.outputs[1] };
}

function addEntriesToMap(
	entryByKey: Map<string, { entry: EnvelopeEntry; gameOutput: string | undefined }>,
	entries: Array<EnvelopeEntry>,
	gameOutput: string | undefined,
): void {
	for (const entry of entries) {
		if (entry.pkg === undefined) {
			continue;
		}

		const key = entryLookupKey(entry.pkg, entry.project);
		if (!entryByKey.has(key)) {
			entryByKey.set(key, { entry, gameOutput });
		}
	}
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
		addEntriesToMap(entryByKey, entries, gameOutput);
	}

	return entryByKey;
}
