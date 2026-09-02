import { PermissionError, PollTimeoutError } from "@bedrock-rbx/ocale";
import {
	OcaleRunner,
	placeVersionGuardSource,
	readRefusedPlaceVersion,
	runTaskPool,
} from "@isentinel/roblox-runner";
import type {
	OcaleRunnerOptions,
	RemoteRunner,
	RunnerCredentials,
	ScriptResult,
} from "@isentinel/roblox-runner";

import process from "node:process";
import type { Except } from "type-fest";

import type { ResolvedConfig } from "../config/schema.ts";
import { resolvePlaceFilePath } from "../config/schema.ts";
import { countLinesThroughLastDirective } from "../luau/directive-header.ts";
import { NOOP_RUN_PROGRESS, type RunProgress } from "../progress/reporter.ts";
import { describePlaceFile, describeProjectCount } from "../progress/stages.ts";
import { generateTestScript, type JestArgvInput } from "../test-script.ts";
import { errorChain, formatMissingScopes, walkErrorChain } from "../utils/error-chain.ts";
import type { DecodedEnvelope } from "./envelope.ts";
import { decodeEnvelope, isEnvelopeDeferred } from "./envelope.ts";
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
	invalidateIfBehindHead,
	isBehindHead,
	readCachedVersion,
	writeCachedVersion,
} from "./upload-cache.ts";

const PINNED_RETRY_NOTE = "Tasks retried pinned (slower, cold place boot).";

/**
 * The whole body of the boot probe — the smallest script that proves a place
 * version starts a session. Nothing about the run may leak into it: it must
 * fail for one reason only, which is that Roblox could not boot the place.
 */
export const BOOT_PROBE_SCRIPT = "return 1";

/**
 * The probe an owned run sends instead, which answers one more question for
 * the same price: `return 1` proves a place booted, not which one. An owned
 * run submits on head, so this is what tells it whether head is still the
 * version it uploaded — the fact its whole fast path rests on.
 */
export const OWNED_BOOT_PROBE_SCRIPT = "return tostring(game.PlaceVersion)";

/**
 * Deadline Roblox is given to run the boot probe, once the place has booted.
 *
 * Kept short and independent of the probe's wall-clock budget. Were the two
 * the same number they would expire together, and a place that booted just
 * inside the budget would be reported as one Roblox cannot start while its
 * script ran. `return 1` needs none of this — anything it cannot finish in ten
 * seconds is a fault Roblox will name for itself.
 */
const BOOT_PROBE_TASK_TIMEOUT_MS = 10_000;

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

/** What one raced task turned out to mean, once the cache had its say. */
interface RaceDiagnosis {
	bootedVersion: number;
	/** True when this task's evidence dropped the entry the run reused. */
	isStaleCache: boolean;
	versionNumber: number;
}

/**
 * The version tasks are asked to boot, plus the cache entry that claimed it.
 * The entry rides along only for a reused version — that is the one case where
 * the guard firing proves the entry is stale rather than merely unlucky.
 */
interface VersionContext {
	/**
	 * True when the boot probe passed against this version in this run, which
	 * rules out the place Roblox cannot load that the runner otherwise falls
	 * back to naming. A cache hit carries no such proof: its entry says the
	 * bytes booted when it was written.
	 */
	bootProven: boolean;
	cacheEntry: undefined | { rootDirectory: string; target: UploadCacheTarget };
	/**
	 * True when the boot probe read head back and found this run's own version,
	 * so the guard has no race left to catch.
	 *
	 * Measured rather than declared. {@link ResolvedConfig.ownedPlace} is a
	 * claim the CLI cannot check on its own — it says no other run writes this
	 * place *now*, and says nothing about who wrote it before this run took the
	 * lease, so a version reused from the upload cache may sit behind a
	 * previous holder's. The probe settles it for free, and a run whose claim
	 * does not survive that check keeps the guard.
	 */
	isOwned: boolean;
	versionNumber: number;
}

interface UploadOutcome {
	/** True when the version came from the cache instead of a fresh upload. */
	fromCache: boolean;
	/**
	 * Hash of the uploaded place bytes, or undefined when this run keeps no
	 * cache. Carried out of the upload so the entry is written only once the
	 * boot probe has proved the version starts.
	 */
	hash: string | undefined;
	uploadMs: number;
	versionNumber: number;
}

interface StealingPoolOutcome {
	failure?: { error: Error };
	results: Array<ScriptResult>;
}

/** One package's entry plus the task-level game output it arrived with. */
interface CollectedEntry {
	entry: EnvelopeEntry;
	gameOutput: string | undefined;
}

interface StealingEnvelope extends DecodedEnvelope {
	gameOutput: string | undefined;
}

/** What one dispatch produced, minus the timing the caller measures itself. */
type DispatchOutcome = Except<BackendResult, "timing">;

export class OpenCloudBackend implements Backend {
	/**
	 * Kept so the upload cache can key on the universe and place it targets.
	 */
	private readonly credentials: OpenCloudCredentials;
	private readonly runner: RemoteRunner;

	/** One-shot per run so parallel raced tasks don't repeat the warning. */
	private raceWarned!: boolean;
	/** Tracked apart, so a drop still gets said once a lesser cause warned. */
	private staleCacheWarned!: boolean;

	public readonly kind = "open-cloud" as const;

	constructor(credentials: OpenCloudCredentials, options?: OpenCloudOptions) {
		this.credentials = credentials;
		this.runner = options?.runner ?? new OcaleRunner(credentials, resolveRunnerOptions());
	}

	public async runTestsAsync(options: BackendOptions): Promise<BackendResult> {
		const {
			jobs,
			progress = NOOP_RUN_PROGRESS,
			scriptOverride,
			workStealing: isStealing,
		} = options;
		this.raceWarned = false;
		this.staleCacheWarned = false;
		const primary = resolvePrimaryJob(jobs, scriptOverride, isStealing);
		// timeout and bootProbeTimeout are picked from the first job — both are
		// per-run knobs, and one run boots one version of one place.
		const target = toCacheTarget(this.credentials, resolvePlaceFilePath(primary.config));

		const attemptAsync = async (upload: UploadOutcome): Promise<DispatchOutcome> => {
			return this.bootAndDispatchAsync({ options, primary, progress, target, upload });
		};

		const upload = await this.uploadOrReuseAsync({ config: primary.config, progress, target });
		const executionStart = Date.now();
		const { extraUploadMs, outcome } = await this.executeReusingUploadAsync(
			{ config: primary.config, progress, target, upload },
			attemptAsync,
		);

		return splitUploadAndExecution({
			executionStart,
			extraUploadMs,
			outcome,
			uploadMs: upload.uploadMs,
		});
	}

	/**
	 * One attempt against one place version: prove it boots, then run every job
	 * on it. The self-heal path calls this a second time with a fresh upload,
	 * so the `tests` stage reopens rather than reporting twice.
	 */
	private async bootAndDispatchAsync({
		options,
		primary,
		progress,
		target,
		upload,
	}: {
		options: BackendOptions;
		primary: ProjectJob;
		progress: RunProgress;
		target: UploadCacheTarget;
		upload: UploadOutcome;
	}): Promise<DispatchOutcome> {
		const isHeadOurs = await this.verifyBootAsync({
			config: primary.config,
			progress,
			target,
			upload,
		});
		// Closed on success only: a dispatch that throws leaves the stage open,
		// and the reporter then names it as the step the run died inside.
		const done = progress.begin("tests", describeProjectCount(options.jobs.length));
		const outcome = await this.dispatchAsync(
			options,
			primary.config,
			toVersionContext(primary.config.rootDir, target, upload, isHeadOurs),
		);
		done();
		return outcome;
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
		version: VersionContext,
	): Promise<DispatchOutcome> {
		if (workStealing === true) {
			return this.runWorkStealingAsync({
				jobs,
				parallel,
				primaryConfig,
				// eslint-disable-next-line ts/no-non-null-assertion -- length checked above
				scriptOverride: scriptOverride!,
				streaming,
				version,
			});
		}

		if (scriptFactory !== undefined) {
			return this.runDeferrableAsync({
				jobs,
				primaryConfig,
				scriptFactory,
				scriptOverride,
				version,
			});
		}

		return this.runStaticBucketsAsync({ jobs, parallel, scriptOverride, version });
	}

	/**
	 * Optimistic version pinning. Pinned tasks
	 * (`/versions/{v}/luau-execution-session-tasks`) miss the warm-server pool
	 * whenever no server holds the freshly-uploaded version yet, costing a cold
	 * place boot per task (~10-45s, scaling with place size). Unpinned tasks
	 * boot the latest saved version from the warm pool, so the first attempt
	 * runs unpinned with a guard prepended: if the booted server is not on
	 * this run's version, the task refuses — naming the version it did boot —
	 * instead of running. On a refusal, the task is retried once, pinned —
	 * correct by construction, no re-upload (the version exists even when it is
	 * no longer head), and no unpinned retry loop for a concurrent uploader to
	 * keep winning against.
	 */
	private async executeGuardedAsync({
		script,
		timeout,
		version,
	}: {
		script: string;
		timeout: number;
		version: VersionContext;
	}): Promise<ScriptResult> {
		// An owned place has one writer, so head already holds this run's
		// version: the guard could only ever pass, and the retry it exists to
		// trigger could never fire. Skipping both keeps every submit on head.
		if (version.isOwned) {
			return this.runner
				.executeScriptAsync({ bootProven: version.bootProven, script, timeout })
				.catch(rethrowOversizedResult);
		}

		const guarded = injectVersionGuard(script, version.versionNumber);
		const first = await this.runner
			.executeScriptAsync({ bootProven: version.bootProven, script: guarded, timeout })
			.catch(rethrowOversizedResult);
		const bootedVersion = readRefusedPlaceVersion(first.outputs[0]);
		return bootedVersion === undefined
			? first
			: this.retryPinnedAsync({ bootedVersion, script, timeout, version });
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
			progress,
			target,
			upload,
		}: {
			config: ResolvedConfig;
			progress: RunProgress;
			target: UploadCacheTarget;
			upload: UploadOutcome;
		},
		executeAsync: (uploadOutcome: UploadOutcome) => Promise<DispatchOutcome>,
	): Promise<{ extraUploadMs: number; outcome: DispatchOutcome }> {
		try {
			return { extraUploadMs: 0, outcome: await executeAsync(upload) };
		} catch (err) {
			if (!upload.fromCache || !isMissingVersionError(err)) {
				throw err;
			}

			process.stderr.write(
				"Warning: cached place version is gone — re-uploading and retrying.\n",
			);
			invalidateCachedVersion(config.rootDir, target);
			const fresh = await this.uploadOrReuseAsync({ config, progress, target });
			return { extraUploadMs: fresh.uploadMs, outcome: await executeAsync(fresh) };
		}
	}

	/**
	 * The guard fired, so head has moved: rerun this task pinned to the version
	 * the run uploaded, which still exists and still holds its bytes.
	 */
	private async retryPinnedAsync({
		bootedVersion,
		script,
		timeout,
		version,
	}: {
		bootedVersion: number;
		script: string;
		timeout: number;
		version: VersionContext;
	}): Promise<ScriptResult> {
		// Dropping a stale entry is deliberately not one-shot the way a warning
		// is: parallel tasks can boot different versions, and only the one that
		// booted past ours carries the proof. Spending that proof on a task
		// with a lesser complaint would keep the entry for good.
		const { cacheEntry, versionNumber } = version;
		const isStaleCache =
			cacheEntry !== undefined &&
			invalidateIfBehindHead(cacheEntry.rootDirectory, cacheEntry.target, {
				bootedVersion,
				reusedVersion: versionNumber,
			});
		this.warnRace({ bootedVersion, isStaleCache, versionNumber });
		return this.runner
			.executeScriptAsync({
				bootProven: version.bootProven,
				placeVersion: versionNumber,
				script,
				timeout,
			})
			.catch(rethrowOversizedResult);
	}

	private async runBucketAsync({
		bucket: { indices, jobs },
		scriptOverride,
		version,
	}: {
		bucket: JobBucket;
		scriptOverride: string | undefined;
		version: VersionContext;
	}): Promise<{ indices: Array<number>; rawResults: Array<RawBackendEntry> }> {
		// A bucket is only created for at least one job, so jobs[0] is defined.
		// eslint-disable-next-line ts/no-non-null-assertion -- bucket non-empty
		const primary = jobs[0]!;
		const inputs: Array<JestArgvInput> = jobs.map((job) => {
			return { config: job.config, testFiles: job.testFiles };
		});

		const script = scriptOverride ?? generateTestScript(inputs);
		const scriptResult = await this.executeGuardedAsync({
			script,
			timeout: primary.config.timeout,
			version,
		});

		const jestOutput = scriptResult.outputs[0];
		if (jestOutput === undefined) {
			throw new Error(
				`No test results in output. Got: ${JSON.stringify(scriptResult.outputs)}`,
			);
		}

		const fallbackGameOutput = scriptResult.outputs[1];
		const { entries } = decodeEnvelope(jestOutput);
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
		primaryConfig,
		scriptFactory,
		scriptOverride,
		version,
	}: {
		jobs: Array<ProjectJob>;
		primaryConfig: ResolvedConfig;
		scriptFactory: (jobs: ReadonlyArray<ProjectJob>) => string;
		scriptOverride: string | undefined;
		version: VersionContext;
	}): Promise<DispatchOutcome> {
		const collected = new Map<string, CollectedEntry>();
		let remaining: Array<ProjectJob> = jobs;
		let script = scriptOverride ?? scriptFactory(jobs);
		let hasBailed = false;

		// One attempt per job is the ceiling: a task always runs at least one
		// entry, so it cannot take more rounds than there are jobs.
		for (const _attempt of jobs) {
			const scriptResult = await this.executeGuardedAsync({
				script,
				timeout: primaryConfig.timeout,
				version,
			});

			const envelope = decodeEnvelope(requireJestOutput(scriptResult));
			addEntriesToMap(collected, envelope.entries, scriptResult.outputs[1]);
			hasBailed ||= envelope.bailed;
			if (!envelope.deferred) {
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

		return collectStealingResults({ bailed: hasBailed, entryByKey: collected, jobs });
	}

	private async runStaticBucketsAsync({
		jobs,
		parallel,
		scriptOverride,
		version,
	}: {
		jobs: Array<ProjectJob>;
		parallel: BackendOptions["parallel"];
		scriptOverride: string | undefined;
		version: VersionContext;
	}): Promise<DispatchOutcome> {
		const buckets = bucketJobs(jobs, parallel);
		const bucketResults = await Promise.all(
			buckets.map(async (bucket) => this.runBucketAsync({ bucket, scriptOverride, version })),
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

		return { rawResults: flattened };
	}

	private async runWorkStealingAsync({
		jobs,
		parallel,
		primaryConfig,
		scriptOverride,
		streaming,
		version,
	}: {
		jobs: Array<ProjectJob>;
		parallel: BackendOptions["parallel"];
		primaryConfig: ResolvedConfig;
		scriptOverride: string;
		streaming: StreamingHooks | undefined;
		version: VersionContext;
	}): Promise<DispatchOutcome> {
		const taskResults = await drainStealingPoolAsync(
			resolveBucketCount(parallel, jobs.length),
			async () => {
				return this.executeGuardedAsync({
					script: scriptOverride,
					timeout: primaryConfig.timeout,
					version,
				});
			},
			streaming,
			jobs.length,
		);

		// Parse after the pool settles so a task that returned no usable output
		// throws here, in the normal flow, rather than being swallowed by the
		// pool's per-task error handling.
		const taskEnvelopes = taskResults.map(parseStealingEnvelope);
		return collectStealingResults({
			bailed: taskEnvelopes.some((envelope) => envelope.bailed),
			entryByKey: aggregateEntriesByKey(taskEnvelopes),
			jobs,
		});
	}

	/**
	 * Send the probe and hand back what it printed, or fail naming the version
	 * Roblox could not start.
	 */
	private async submitBootProbeAsync({
		budget,
		isOwnedProbe,
		target,
		upload,
	}: {
		budget: number;
		isOwnedProbe: boolean;
		target: UploadCacheTarget;
		upload: UploadOutcome;
	}): Promise<string | undefined> {
		try {
			const result = await this.runner.executeScriptAsync({
				// Pinning is what makes the probe expensive: a pinned submit
				// misses the warm pool and boots the place cold (measured 12.2s
				// median against 3.0s on head, same bytes). An owned run has
				// just moved head itself, so an unpinned probe reaches the same
				// bytes at head's price. Elsewhere the pin is the point —
				// another writer's head would prove nothing about ours.
				...(isOwnedProbe ? {} : { placeVersion: upload.versionNumber }),
				// A wall-clock cap, not a deadline: the question is whether the
				// place booted, and the runner's boot-lag allowance answers a
				// different one — it would only delay the verdict.
				pollBudget: budget,
				script: isOwnedProbe ? OWNED_BOOT_PROBE_SCRIPT : BOOT_PROBE_SCRIPT,
				timeout: Math.min(BOOT_PROBE_TASK_TIMEOUT_MS, budget),
			});
			return result.outputs[0];
		} catch (err) {
			rethrowBootProbeFailure(err, {
				budget,
				placeFilePath: target.placeFilePath,
				versionNumber: upload.versionNumber,
			});
		}
	}

	/**
	 * Skip `places.save` when these exact place bytes already have a version.
	 * An upload is the only thing measured to precede a cold place boot (~22s
	 * against ~3s warm), so an unchanged build that reuses its version keeps
	 * the fast path. Correctness rests on the guard in
	 * {@link OpenCloudBackend.executeGuardedAsync}, not on the cache: a stale
	 * entry can only make the sentinel fire and the task retry pinned to the
	 * recorded version, which holds exactly the bytes that were hashed. The
	 * guard also reports the version it did boot, which is what lets
	 * {@link invalidateIfBehindHead} drop an entry that is behind head.
	 *
	 * Reads the cache but never writes it: an entry means "these bytes boot",
	 * so only {@link OpenCloudBackend.verifyBootAsync} may record one. The
	 * hash rides out on the outcome for it to write with.
	 */
	private async uploadOrReuseAsync({
		config,
		progress,
		target,
	}: {
		config: ResolvedConfig;
		progress: RunProgress;
		target: UploadCacheTarget;
	}): Promise<UploadOutcome> {
		const start = Date.now();
		const hash = config.uploadCache ? hashPlaceFile(target.placeFilePath) : undefined;
		// A hash of undefined means "no cache this run" for both reads and
		// writes: either the caller disabled it, or the file could not be read.
		if (hash !== undefined) {
			const cached = readCachedVersion(config.rootDir, target, hash);
			if (cached !== undefined) {
				// Noted rather than opened: nothing went over the wire, so the
				// stage has a result and never had a wait.
				progress.note("upload", `cache hit, version ${cached.toString()}`);
				return {
					fromCache: true,
					hash,
					uploadMs: Date.now() - start,
					versionNumber: cached,
				};
			}
		}

		const done = progress.begin("upload", describePlaceFile(target.placeFilePath));
		const upload = await this.runner.uploadPlaceAsync({
			placeFilePath: target.placeFilePath,
		});
		done(`version ${upload.versionNumber.toString()}`);

		return {
			fromCache: false,
			hash,
			uploadMs: Date.now() - start,
			versionNumber: upload.versionNumber,
		};
	}

	/**
	 * Prove a freshly uploaded version boots, before any test task rides on it.
	 *
	 * Roblox says nothing at all about a place version it cannot start: the
	 * task is accepted, stays `PROCESSING` past every deadline, and carries no
	 * error and no log. Left alone that costs the whole run budget and ends in
	 * a guess. One trivial pinned task answers it in the time a cold boot takes
	 * — time the first real task would have paid anyway — and with
	 * `parallel > 1` it leaves a warm server behind instead of starting N cold
	 * boots at once.
	 *
	 * The version is recorded in the upload cache only once it has passed, so
	 * the entry means "these bytes boot" and a later run may skip the probe on
	 * the strength of it. A budget of zero turns the probe off, and takes the
	 * cache entry with it: there is nothing left to record.
	 */
	private async verifyBootAsync({
		config,
		progress,
		target,
		upload,
	}: {
		config: ResolvedConfig;
		progress: RunProgress;
		target: UploadCacheTarget;
		upload: UploadOutcome;
	}): Promise<boolean> {
		const budget = config.bootProbeTimeout;
		if (budget === 0 || upload.fromCache) {
			return false;
		}

		// Only a version this run uploaded can be head by its own doing, so a
		// reused one never takes this path and never earns the claim.
		const isOwnedProbe = config.ownedPlace;
		const done = progress.begin("boot", `version ${upload.versionNumber.toString()}`);
		const booted = await this.submitBootProbeAsync({ budget, isOwnedProbe, target, upload });
		done();
		// The probe is the one submit that can answer "is head still mine?"
		// for free, so an owned run spends it on checking the claim rather than
		// trusting it. A claim that fails here means something else wrote the
		// place: the guard has to come back, and the bytes that booted were not
		// ours to record.
		const isHeadOurs = isOwnedProbe && booted === String(upload.versionNumber);
		if (isOwnedProbe && !isHeadOurs) {
			warnOwnershipBroken(upload.versionNumber, booted);
			return false;
		}

		if (upload.hash !== undefined) {
			writeCachedVersion(config.rootDir, target, upload.hash, upload.versionNumber);
		}

		return isHeadOurs;
	}

	/**
	 * Name the cause of a mismatch, at most once per cause.
	 *
	 * A dropped cache entry is always said out loud, even when a task with a
	 * lesser complaint reported first and spent the ordinary warning: it is the
	 * one cause that changed state on disk, and the only thing that explains
	 * the upload the next run makes.
	 */
	private warnRace(diagnosis: RaceDiagnosis): void {
		if (diagnosis.isStaleCache ? this.staleCacheWarned : this.raceWarned) {
			return;
		}

		this.staleCacheWarned ||= diagnosis.isStaleCache;
		this.raceWarned = true;
		process.stderr.write(
			`Warning: ${describeVersionMismatch(diagnosis)} ${PINNED_RETRY_NOTE}\n`,
		);
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

/**
 * Name what went wrong, rather than blaming the one cause the guard cannot
 * distinguish on its own. A booted version ahead of ours means someone else's
 * upload is head — a race against a fresh upload, a stale entry against a
 * reused one. Behind ours means nothing raced at all: the save has yet to reach
 * the boot pool.
 */
function describeVersionMismatch({
	bootedVersion,
	isStaleCache,
	versionNumber,
}: RaceDiagnosis): string {
	const booted = `a task booted ${String(bootedVersion)}`;
	if (isStaleCache) {
		return (
			`cached place version ${String(versionNumber)} is no longer head — ${booted}. ` +
			"Cache entry dropped, so the next run re-uploads."
		);
	}

	if (isBehindHead({ bootedVersion, reusedVersion: versionNumber })) {
		return `place version ${String(versionNumber)} raced by a concurrent upload — ${booted}.`;
	}

	return `place version ${String(versionNumber)} is not in the boot pool yet — ${booted}.`;
}

/**
 * Split the run's wall clock into the two numbers the result carries. A
 * self-heal re-upload runs inside the execution window, so it belongs to
 * `uploadMs` and comes back out of `executionMs`.
 */
function splitUploadAndExecution({
	executionStart,
	extraUploadMs,
	outcome,
	uploadMs,
}: {
	executionStart: number;
	extraUploadMs: number;
	outcome: DispatchOutcome;
	uploadMs: number;
}): BackendResult {
	return {
		...outcome,
		timing: {
			executionMs: Date.now() - executionStart - extraUploadMs,
			uploadMs: uploadMs + extraUploadMs,
		},
	};
}

function toVersionContext(
	rootDirectory: string,
	target: UploadCacheTarget,
	upload: UploadOutcome,
	isHeadOurs: boolean,
): VersionContext {
	return {
		bootProven: !upload.fromCache,
		cacheEntry: upload.fromCache ? { rootDirectory, target } : undefined,
		isOwned: isHeadOurs,
		versionNumber: upload.versionNumber,
	};
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
 * Insert the version guard behind the script's header block — Luau honors
 * `--!strict`/`--!native`/etc only while nothing else has opened the file, so
 * a plain line-1 prepend would silently disable a caller's directives.
 */
function injectVersionGuard(script: string, placeVersion: number): string {
	const lines = script.split("\n");

	lines.splice(countLinesThroughLastDirective(lines), 0, placeVersionGuardSource(placeVersion));
	return lines.join("\n");
}

/**
 * Say that `ownedPlace` was wrong, because nothing else will. The run stays
 * correct — the guard comes back and the tasks still get the right bytes — so
 * only this line distinguishes a lease that is working from one that is
 * quietly handing the same place to two runs.
 */
function warnOwnershipBroken(versionNumber: number, bootedVersion: string | undefined): void {
	process.stderr.write(
		`Warning: ownedPlace was set, but head is ${bootedVersion ?? "unreadable"} rather than ` +
			`the uploaded version ${String(versionNumber)} — another run wrote this place.\n` +
			"  Falling back to the version guard for this run; check the lease that set the flag.\n",
	);
}

function resolveRunnerOptions(): OcaleRunnerOptions {
	const baseUrl = resolveOpenCloudBaseUrl();
	const maxRetries = resolveOcaleMaxRetries();
	return {
		baseUrl,
		maxRetries,
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
	const buckets = Array.from({ length: bucketCount }, (): JobBucket => {
		return {
			indices: [],
			jobs: [],
		};
	});

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

/**
 * Turn a boot probe that never came back into the one verdict Roblox will not
 * give: this place version does not start.
 *
 * Only a poll timeout earns that reading. The probe is `return 1`, so nothing
 * about it can fail on its own — but the call still travels over the same API
 * as everything else, and a 401 or a 429 says something about the request, not
 * about the place. Those pass through untouched.
 *
 * The remedy names Studio because Studio is the only thing that says *why*:
 * Open Cloud reports no state, no error and no log for a place it could not
 * load, and there is no other endpoint to read.
 */
function rethrowBootProbeFailure(
	err: unknown,
	context: { budget: number; placeFilePath: string; versionNumber: number },
): never {
	if (errorChain(err).every((entry) => !(entry instanceof PollTimeoutError))) {
		throw err;
	}

	const lines = [
		`Place version ${String(context.versionNumber)} cannot be started by Open Cloud.`,
		`A trivial script against it also never ran (${String(Math.round(context.budget / 1000))}s).`,
		"Roblox reports no state, no error, and no log for a place it cannot load.",
		`Open ${context.placeFilePath} in Studio, or run with`,
		"--backend=studio-cli, to see why it will not load.",
	];
	throw new Error(lines.join("\n"), { cause: err });
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
			"Only files in the coverage universe are probed, so narrowing " +
			"`collectCoverageFrom` to what you actually report on shrinks the " +
			"payload with it.\n" +
			'Otherwise set `parallel: "auto"` (or --parallel 2+) so results come ' +
			"back split across tasks, or narrow the run with --packages / --project.",
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
 * Pair every job with its aggregated entry, in request order.
 *
 * A gap normally means a task broke and lost its results, so they are collected
 * and one failure message names them all rather than failing on the first.
 * Under `--bail` the gaps are the point: the run stopped on a failing package
 * and the ones after it were never meant to run, so they come back reported as
 * bailed instead.
 *
 * That trade is real — once any task reports a bail, a sibling that lost
 * results some other way is reported as deliberately skipped too. Nothing here
 * can tell the two apart: the queue is drained in no particular order, so
 * "after the failing package" names no set. A task that dies outright still
 * fails the run through the pool's captured error; what this gives up is the
 * narrower case of a task that returns successfully having lost entries.
 */
function collectStealingResults({
	bailed,
	entryByKey,
	jobs,
}: {
	bailed: boolean;
	entryByKey: Map<string, CollectedEntry>;
	jobs: Array<ProjectJob>;
}): DispatchOutcome {
	const bailedJobIndices: Array<number> = [];
	const rawResults: Array<RawBackendEntry> = [];
	for (const [index, job] of jobs.entries()) {
		const found = entryByKey.get(entryLookupKey(job.pkg ?? job.displayName, job.displayName));
		if (found === undefined) {
			bailedJobIndices.push(index);
			continue;
		}

		rawResults.push({ entry: found.entry, fallbackGameOutput: found.gameOutput });
	}

	if (bailed) {
		return { bailedJobIndices, rawResults };
	}

	if (bailedJobIndices.length > 0) {
		const names = bailedJobIndices.map((index) => jobs[index]?.displayName).join(", ");
		throw new Error(
			`Open Cloud work-stealing returned no entries for ${bailedJobIndices.length.toString()} package(s): ${names}`,
		);
	}

	return { rawResults };
}

/**
 * Decode one work-stealing task's return envelope. Throws when the task
 * produced no Jest output so a broken task surfaces as a run failure rather
 * than a silently-missing package.
 */
function parseStealingEnvelope(result: ScriptResult): StealingEnvelope {
	const jestOutput = result.outputs[0];
	if (jestOutput === undefined) {
		throw new Error(`No test results in output. Got: ${JSON.stringify(result.outputs)}`);
	}

	return { ...decodeEnvelope(jestOutput), gameOutput: result.outputs[1] };
}

function addEntriesToMap(
	entryByKey: Map<string, CollectedEntry>,
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
): Map<string, CollectedEntry> {
	const entryByKey = new Map<string, CollectedEntry>();
	for (const { entries, gameOutput } of taskEnvelopes) {
		addEntriesToMap(entryByKey, entries, gameOutput);
	}

	return entryByKey;
}
