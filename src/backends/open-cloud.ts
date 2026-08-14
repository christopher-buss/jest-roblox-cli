import { PermissionError } from "@bedrock-rbx/ocale";
import { OcaleRunner, runTaskPool } from "@isentinel/roblox-runner";
import type { RemoteRunner, RunnerCredentials, ScriptResult } from "@isentinel/roblox-runner";

import process from "node:process";

import type { ResolvedConfig } from "../config/schema.ts";
import { resolvePlaceFilePath } from "../config/schema.ts";
import { generateTestScript, type JestArgvInput } from "../test-script.ts";
import { formatMissingScopes, walkErrorChain } from "../utils/error-chain.ts";
import { isEnvelopeDeferred, parseEnvelope } from "./envelope.ts";
import type {
	Backend,
	BackendOptions,
	BackendResult,
	EnvelopeEntry,
	ProjectJob,
	RawBackendEntry,
	StreamingHooks,
} from "./interface.ts";
import type { UploadCacheTarget } from "./upload-cache.ts";
import {
	hashPlaceFile,
	invalidateCachedVersion,
	readCachedVersion,
	writeCachedVersion,
} from "./upload-cache.ts";

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

export type OpenCloudCredentials = RunnerCredentials;

export interface OpenCloudOptions {
	/**
	 * Inject a pre-built {@link RemoteRunner}. When provided, the
	 * `credentials` argument to {@link OpenCloudBackend} is ignored —
	 * the injected runner already owns its own credentials. Intended
	 * primarily as a test seam.
	 */
	runner?: RemoteRunner | undefined;
}

interface JobBucket {
	indices: Array<number>;
	jobs: Array<ProjectJob>;
}

interface PollState {
	warned: boolean;
}

interface UploadOutcome {
	/** True when the version came from the cache instead of a fresh upload. */
	fromCache: boolean;
	uploadMs: number;
	versionNumber: number;
}

interface StealingPoolOutcome {
	/**
	 * A holder rather than a bare `unknown` so "no failure" stays
	 * distinguishable from "failed with an undefined reason".
	 */
	failure?: undefined | { error: unknown };
	results: Array<ScriptResult>;
}

export class OpenCloudBackend implements Backend {
	/**
	 * Kept so the upload cache can key on the universe and place it targets.
	 */
	private readonly credentials: OpenCloudCredentials;
	private readonly runner: RemoteRunner;

	/** One-shot per run so parallel raced tasks don't repeat the warning. */
	private raceWarned = false;

	public readonly kind = "open-cloud" as const;

	constructor(credentials: OpenCloudCredentials, options?: OpenCloudOptions) {
		this.credentials = credentials;
		this.runner = options?.runner ?? new OcaleRunner(credentials, resolveRunnerOptions());
	}

	public async runTestsAsync({
		jobs,
		parallel,
		scriptFactory,
		scriptOverride,
		streaming,
		workStealing,
	}: BackendOptions): Promise<BackendResult> {
		this.raceWarned = false;
		const primary = resolvePrimaryJob(jobs, scriptOverride, workStealing);
		// timeout is picked from the first job — it's a per-run knob.
		const target = toCacheTarget(this.credentials, resolvePlaceFilePath(primary.config));

		const upload = await this.uploadOrReuseAsync(primary.config, target);
		const executeAsync = async (placeVersion: number): Promise<Array<RawBackendEntry>> => {
			return this.dispatchAsync(
				{ jobs, parallel, scriptFactory, scriptOverride, streaming, workStealing },
				primary.config,
				placeVersion,
			);
		};

		const executionStart = Date.now();
		const { extraUploadMs, rawResults } = await this.executeReusingUploadAsync(
			{ config: primary.config, target, upload },
			executeAsync,
		);

		return {
			rawResults,
			// A self-heal re-upload runs inside the execution window, so it
			// belongs to `uploadMs` and comes back out of `executionMs`.
			timing: {
				executionMs: Date.now() - executionStart - extraUploadMs,
				uploadMs: upload.uploadMs + extraUploadMs,
			},
		};
	}

	/**
	 * Pick the execution shape for one run.
	 *
	 * Work-stealing fans out over a shared queue. A workspace run without it
	 * shares one script across every job, so it runs one task at a time and
	 * re-sends what a task defers. Everything else splits jobs into buckets and
	 * generates a script per bucket.
	 */
	private async dispatchAsync(
		{ jobs, parallel, scriptFactory, scriptOverride, streaming, workStealing }: BackendOptions,
		primaryConfig: ResolvedConfig,
		placeVersion: number,
	): Promise<Array<RawBackendEntry>> {
		if (workStealing === true) {
			return this.runWorkStealingAsync({
				jobs,
				parallel,
				placeVersion,
				primaryConfig,
				// eslint-disable-next-line ts/no-non-null-assertion -- length checked above
				scriptOverride: scriptOverride!,
				streaming,
			});
		}

		if (scriptFactory !== undefined) {
			return this.runDeferrableAsync({
				jobs,
				placeVersion,
				primaryConfig,
				scriptFactory,
				scriptOverride,
			});
		}

		return this.runStaticBucketsAsync(jobs, parallel, placeVersion, scriptOverride);
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
	private async executeGuardedAsync({
		placeVersion,
		script,
		timeout,
	}: {
		placeVersion: number;
		script: string;
		timeout: number;
	}): Promise<ScriptResult> {
		const guarded = injectVersionGuard(script, placeVersion);
		const first = await this.runner
			.executeScriptAsync({ script: guarded, timeout })
			.catch(rethrowOversizedResult);
		if (first.outputs[0] !== PLACE_VERSION_RACE_SENTINEL) {
			return first;
		}

		if (!this.raceWarned) {
			this.raceWarned = true;
			process.stderr.write(
				"Warning: place version raced by a concurrent upload — raced tasks retried pinned (slower, cold place boot).\n",
			);
		}

		return this.runner
			.executeScriptAsync({ placeVersion, script, timeout })
			.catch(rethrowOversizedResult);
	}

	/**
	 * Run the wave, and give a reused version exactly one second chance: if
	 * Roblox no longer serves the cached version, drop the entry, upload for
	 * real, and run again. Without this a bad entry fails every later run the
	 * same way, since nothing else ever rewrites it.
	 */
	private async executeReusingUploadAsync(
		{
			config,
			target,
			upload,
		}: {
			config: ResolvedConfig;
			target: UploadCacheTarget;
			upload: UploadOutcome;
		},
		executeAsync: (placeVersion: number) => Promise<Array<RawBackendEntry>>,
	): Promise<{ extraUploadMs: number; rawResults: Array<RawBackendEntry> }> {
		try {
			return { extraUploadMs: 0, rawResults: await executeAsync(upload.versionNumber) };
		} catch (err) {
			if (!upload.fromCache || !isMissingVersionError(err)) {
				throw err;
			}

			process.stderr.write(
				"Warning: cached place version is gone — re-uploading and retrying.\n",
			);
			invalidateCachedVersion(config.rootDir, target);
			const fresh = await this.uploadOrReuseAsync(config, target);
			return {
				extraUploadMs: fresh.uploadMs,
				rawResults: await executeAsync(fresh.versionNumber),
			};
		}
	}

	private async runBucketAsync(
		{ indices, jobs }: JobBucket,
		placeVersion: number,
		scriptOverride?: string,
	): Promise<{ indices: Array<number>; rawResults: Array<RawBackendEntry> }> {
		// A bucket is only created for at least one job, so jobs[0] is defined.
		// eslint-disable-next-line ts/no-non-null-assertion -- bucket non-empty
		const primary = jobs[0]!;
		const inputs: Array<JestArgvInput> = jobs.map((job) => {
			return { config: job.config, testFiles: job.testFiles };
		});

		const script = scriptOverride ?? generateTestScript(inputs);
		const scriptResult = await this.executeGuardedAsync({
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

	/**
	 * Run a workspace script that carries every entry, re-sending whatever a
	 * task left behind.
	 *
	 * There is no queue on this path, so a task that fills its return-envelope
	 * budget cannot hand the rest to a sibling. It reports `deferred` instead
	 * and the backend builds a fresh script from the jobs that did not come
	 * back. One task at a time: every job shares the one script, so running it
	 * concurrently would repeat the whole run per task rather than divide it.
	 *
	 * A task always runs at least one entry, so N jobs need at most N tasks —
	 * and a round that covers nothing new stops the loop rather than spending
	 * the rest of that budget on tasks that cannot make progress.
	 */
	private async runDeferrableAsync({
		jobs,
		placeVersion,
		primaryConfig,
		scriptFactory,
		scriptOverride,
	}: {
		jobs: Array<ProjectJob>;
		placeVersion: number;
		primaryConfig: ResolvedConfig;
		scriptFactory: (jobs: ReadonlyArray<ProjectJob>) => string;
		scriptOverride: string | undefined;
	}): Promise<Array<RawBackendEntry>> {
		const collected = new Map<
			string,
			{ entry: EnvelopeEntry; gameOutput: string | undefined }
		>();
		let remaining: Array<ProjectJob> = jobs;
		let script = scriptOverride ?? scriptFactory(jobs);

		// One attempt per job is the ceiling: a task always runs at least one
		// entry, so it cannot take more rounds than there are jobs.
		for (const _attempt of jobs) {
			const scriptResult = await this.executeGuardedAsync({
				placeVersion,
				script,
				timeout: primaryConfig.timeout,
			});

			const jestOutput = requireJestOutput(scriptResult);
			addEntriesToMap(collected, parseEnvelope(jestOutput), scriptResult.outputs[1]);
			if (!isEnvelopeDeferred(jestOutput)) {
				break;
			}

			const outstanding = remaining.filter((job) => {
				return !collected.has(entryLookupKey(job.pkg ?? job.displayName, job.displayName));
			});
			if (outstanding.length === 0 || outstanding.length === remaining.length) {
				break;
			}

			remaining = outstanding;
			script = scriptFactory(remaining);
		}

		return collectStealingResults(jobs, collected);
	}

	private async runStaticBucketsAsync(
		jobs: Array<ProjectJob>,
		parallel: BackendOptions["parallel"],
		placeVersion: number,
		scriptOverride?: string,
	): Promise<Array<RawBackendEntry>> {
		const buckets = bucketJobs(jobs, parallel);
		const bucketResults = await Promise.all(
			buckets.map(async (bucket) => {
				return this.runBucketAsync(bucket, placeVersion, scriptOverride);
			}),
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

	private async runWorkStealingAsync({
		jobs,
		parallel,
		placeVersion,
		primaryConfig,
		scriptOverride,
		streaming,
	}: {
		jobs: Array<ProjectJob>;
		parallel: BackendOptions["parallel"];
		placeVersion: number;
		primaryConfig: ResolvedConfig;
		scriptOverride: string;
		streaming: StreamingHooks | undefined;
	}): Promise<Array<RawBackendEntry>> {
		const taskResults = await drainStealingPoolAsync(
			resolveBucketCount(parallel, jobs.length),
			async () => {
				return this.executeGuardedAsync({
					placeVersion,
					script: scriptOverride,
					timeout: primaryConfig.timeout,
				});
			},
			streaming,
			jobs.length,
		);

		// Parse after the pool settles so a task that returned no usable output
		// throws here, in the normal flow, rather than being swallowed by the
		// pool's per-task error handling.
		const taskEnvelopes = taskResults.map(parseStealingEnvelope);
		return collectStealingResults(jobs, aggregateEntriesByKey(taskEnvelopes));
	}

	/**
	 * Skip `places.save` when these exact place bytes already have a version.
	 * An upload is the only thing measured to precede a cold place boot (~22s
	 * against ~3s warm), so an unchanged build that reuses its version keeps
	 * the fast path. Correctness rests on the guard in
	 * {@link OpenCloudBackend.executeGuardedAsync}, not on the cache: a stale
	 * entry can only make the sentinel fire and the task retry pinned to the
	 * recorded version, which holds exactly the bytes that were hashed.
	 */
	private async uploadOrReuseAsync(
		config: ResolvedConfig,
		target: UploadCacheTarget,
	): Promise<UploadOutcome> {
		const start = Date.now();
		const hash = config.uploadCache ? hashPlaceFile(target.placeFilePath) : undefined;
		// A hash of undefined means "no cache this run" for both reads and
		// writes: either the caller disabled it, or the file could not be read.
		if (hash !== undefined) {
			const cached = readCachedVersion(config.rootDir, target, hash);
			if (cached !== undefined) {
				return { fromCache: true, uploadMs: Date.now() - start, versionNumber: cached };
			}
		}

		const upload = await this.runner.uploadPlaceAsync({
			placeFilePath: target.placeFilePath,
		});
		if (hash !== undefined) {
			writeCachedVersion(config.rootDir, target, hash, upload.versionNumber);
		}

		return {
			fromCache: false,
			uploadMs: Date.now() - start,
			versionNumber: upload.versionNumber,
		};
	}
}

export function resolveOpenCloudBaseUrl(): string | undefined {
	const override = process.env[BASE_URL_ENV]?.trim();
	if (override === undefined || override === "") {
		return undefined;
	}

	let end = override.length;
	while (end > 0 && override.charAt(end - 1) === "/") {
		end -= 1;
	}

	return override.slice(0, end);
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

/**
 * Poll the streaming SortedMap until `isDone()` returns true, then perform
 * one final drain. Each newly-observed entry is forwarded to
 * `onPackageResult` and deleted from the map. Errors are swallowed so a
 * transient HTTP failure doesn't take down the test run — the final task
 * envelope still carries authoritative results.
 */
export async function pollStreamingResultsAsync(
	hooks: StreamingHooks,
	isDone: () => boolean,
): Promise<void> {
	const pollMs = hooks.pollMs ?? DEFAULT_STREAM_POLL_MS;
	const state: PollState = { warned: false };

	while (!isDone()) {
		await drainOnceAsync(hooks, state);
		await sleepAsync(pollMs);
	}

	// Final pass to catch any entries written between the last drain and
	// tasksDone.
	await drainOnceAsync(hooks, state);
}

export function createOpenCloudBackend(credentials: OpenCloudCredentials): OpenCloudBackend {
	return new OpenCloudBackend(credentials);
}

function toCacheTarget(
	credentials: OpenCloudCredentials,
	placeFilePath: string,
): UploadCacheTarget {
	return {
		placeFilePath,
		placeId: credentials.placeId,
		universeId: credentials.universeId,
	};
}

/**
 * True when the failure reads as "that place version does not exist" — the
 * shape a cached version number takes once Roblox no longer serves it. Matches
 * on the API's own 404 rather than on message text, and walks the chain because
 * the runner wraps the client error.
 */
function isMissingVersionError(err: unknown): boolean {
	return walkErrorChain(err).some((entry) => entry.statusCode === 404);
}

function resolvePrimaryJob(
	jobs: Array<ProjectJob>,
	scriptOverride: string | undefined,
	workStealing = false,
): ProjectJob {
	const primary = jobs[0];
	if (primary === undefined) {
		throw new Error("OpenCloudBackend requires at least one job");
	}

	if (workStealing && scriptOverride === undefined) {
		throw new Error("OpenCloudBackend work-stealing mode requires scriptOverride");
	}

	return primary;
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

// Open Cloud's wording when a task's return value exceeds its 4 MiB cap. It
// rejects the whole task, so every package that task ran is lost with it.
const OVERSIZED_RESULT_PATTERN = /Return results too large/i;

/**
 * Rethrow an oversized-return failure with the remedy attached.
 *
 * Work-stealing already keeps a task under the cap by leaving queue items for
 * the next task, so reaching here means the split cannot help: either the run
 * is on the single-task path, or one package's own results exceed the cap.
 * Both need a decision from the user, and Open Cloud's bare message names
 * neither the cause nor a way out.
 */
function rethrowOversizedResult(err: unknown): never {
	if (!(err instanceof Error) || !OVERSIZED_RESULT_PATTERN.test(err.message)) {
		throw err;
	}

	throw new Error(
		`${err.message}\n` +
			"One task returned more Jest output than Open Cloud accepts (4 MiB).\n" +
			"Coverage is usually the bulk of it — try --no-coverage to confirm.\n" +
			'Set `parallel: "auto"` (or --parallel 2+) so results come back split ' +
			"across tasks, or narrow the run with --packages / --project.",
		{ cause: err },
	);
}

/** The Jest envelope a task returned, or a failure naming what came back. */
function requireJestOutput(result: ScriptResult): string {
	const jestOutput = result.outputs[0];
	if (jestOutput === undefined) {
		throw new Error(`No test results in output. Got: ${JSON.stringify(result.outputs)}`);
	}

	return jestOutput;
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

async function drainOnceAsync(hooks: StreamingHooks, state: PollState): Promise<void> {
	let records;
	try {
		records = await hooks.reader.readAllAsync();
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
				await hooks.reader.deleteAsync(record.id);
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

async function sleepAsync(ms: number): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Drive the work-stealing task set through the shared roblox-runner pool.
 *
 * A worker normally drains the queue until it is empty, so `taskCount` tasks
 * cover the known set and no slot ever needs refilling — the wave is exactly
 * `taskCount` tasks, as it was before deferral existed.
 *
 * The exception is a worker that fills its return-envelope budget: Open Cloud
 * rejects a task returning more than 4 MiB, so the worker stops early, leaves
 * the rest of the queue behind and says so (`deferred`). Each deferral earns
 * exactly one replacement launch, which may itself defer, chaining until the
 * queue drains.
 *
 * `maxLaunches` bounds that chain: a worker always takes at least one item, so
 * covering `jobCount` jobs can never need more than `jobCount` extra tasks.
 */
async function runStealingTasksAsync(
	taskCount: number,
	runTask: () => Promise<ScriptResult>,
	outcome: StealingPoolOutcome,
	jobCount: number,
): Promise<void> {
	let launched = 0;
	let pendingDeferrals = 0;
	const maxLaunches = taskCount + jobCount;

	await runTaskPool({
		concurrency: taskCount,
		isDone: () => launched >= taskCount && (pendingDeferrals === 0 || launched >= maxLaunches),
		onError: (error) => {
			// The pool folds a task failure into a freed slot and resolves, so
			// without this the failure would be masked whenever a sibling task
			// drains the whole queue and covers every package. Capture it and
			// rethrow once the pool settles so an infrastructure or script
			// failure always fails the run, as the old `Promise.all` wave did.
			outcome.failure = { error };
		},
		onResult: (result) => {
			outcome.results.push(result);

			const jestOutput = result.outputs[0];
			if (jestOutput !== undefined && isEnvelopeDeferred(jestOutput)) {
				pendingDeferrals += 1;
			}
		},
		places: [
			{
				runTask: async () => {
					// Claim the deferral this launch answers, so two launches
					// never settle the same one.
					if (launched >= taskCount && pendingDeferrals > 0) {
						pendingDeferrals -= 1;
					}

					launched += 1;
					return runTask();
				},
			},
		],
	});
}

/**
 * Run the work-stealing task wave and, when streaming is enabled, poll the
 * streaming map alongside it. Returns every task's result once the wave has
 * settled; rethrows the first task failure the pool folded into a freed slot.
 */
async function drainStealingPoolAsync(
	taskCount: number,
	runTask: () => Promise<ScriptResult>,
	streaming: StreamingHooks | undefined,
	requiredKeyCount: number,
): Promise<Array<ScriptResult>> {
	// A holder, not a plain boolean, so the poll's `isDone` arrow reads the
	// live value instead of capturing false forever.
	const tasksDone = { value: false };
	const outcome: StealingPoolOutcome = { results: [] };
	const poolPromise = runStealingTasksAsync(
		taskCount,
		runTask,
		outcome,
		requiredKeyCount,
	).finally(() => {
		tasksDone.value = true;
	});

	const pollPromise =
		streaming !== undefined
			? pollStreamingResultsAsync(streaming, () => tasksDone.value)
			: Promise.resolve();

	// The pool never rejects (it folds task errors into freed slots) and its
	// `.finally` always flips tasksDone, so pollPromise terminates within
	// ~pollMs — neither promise orphans the other.
	await Promise.all([poolPromise, pollPromise]);

	if (outcome.failure !== undefined) {
		throw outcome.failure.error;
	}

	return outcome.results;
}

function entryLookupKey(packageName: string, project: string | undefined): string {
	return project === undefined || project === packageName
		? packageName
		: `${packageName}::${project}`;
}

/**
 * Pair every job with its aggregated entry, in request order. Jobs whose
 * package never came back are collected so one failure message names them all
 * rather than failing on the first gap.
 */
function collectStealingResults(
	jobs: Array<ProjectJob>,
	entryByKey: Map<string, { entry: EnvelopeEntry; gameOutput: string | undefined }>,
): Array<RawBackendEntry> {
	const missing: Array<string> = [];
	const rawResults: Array<RawBackendEntry> = [];
	for (const job of jobs) {
		const found = entryByKey.get(entryLookupKey(job.pkg ?? job.displayName, job.displayName));
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
