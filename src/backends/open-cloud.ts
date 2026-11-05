import { OcaleRunner } from "@isentinel/roblox-runner";
import type {
	BinaryInputUploader,
	RemoteRunner,
	RunnerCredentials,
	ScriptResult,
} from "@isentinel/roblox-runner";

import { resolvePlaceFilePath } from "../config/schema.ts";
import { ExecutionClaimObserver } from "../luau/execution-claim.ts";
import { prepareTaskScript } from "../luau/task-script.ts";
import { NOOP_RUN_PROGRESS, type RunProgress } from "../progress/reporter.ts";
import { describeProjectCount } from "../progress/stages.ts";
import type { CodeBundleArtifact } from "../staging/code-bundle.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { DEFAULT_BOOT_WATCH_MS, executeWithRecoveryAsync } from "./execution-recovery.ts";
import type { Backend, BackendOptions, BackendResult, ProjectJob } from "./interface.ts";
import { openCloudExecutionBudgets } from "./open-cloud-budgets.ts";
import { type BundleRun, openBundleRun } from "./open-cloud-bundle.ts";
import { dispatchJobsAsync } from "./open-cloud-dispatch.ts";
import type { DispatchOutcome } from "./open-cloud-entries.ts";
import { resolveOpenCloudBaseUrl, resolveRunnerOptions } from "./open-cloud-environment.ts";
import { rethrowOversizedResult } from "./open-cloud-failures.ts";
import {
	PlaceVersionGate,
	toCacheTarget,
	type UploadOutcome,
	type VersionContext,
} from "./open-cloud-place-version.ts";
import { executeWithResultRelayAsync } from "./result-relay.ts";
import type { UploadCacheTarget } from "./upload-cache.ts";

/** API key and the universe and place the run targets. */
export type OpenCloudCredentials = RunnerCredentials;

/** Optional overrides and test seams for {@link OpenCloudBackend}. */
export interface OpenCloudOptions {
	/** Delay before checking whether the first test task acquired its claim. */
	bootWatchMs?: number | undefined;
	/** Override the Open Cloud execution-claim reader. Test seam. */
	executionClaimObserver?: Pick<ExecutionClaimObserver, "readAsync"> | undefined;
	/** Where the Code Bundle is read from. Defaults to the real filesystem. */
	fileSystem?: FileSystem | undefined;
	/**
	 * The clock a binary input's age is measured on. Defaults to the wall
	 * clock; a spec advances it past the refresh threshold without waiting
	 * for an input to age.
	 */
	now?: (() => number) | undefined;
	/**
	 * What gives a task script its preamble. Defaults to the real composer;
	 * a spec injects a counting wrapper around it, because the memo below is
	 * a saving the composed script itself cannot show.
	 */
	prepareScript?: typeof prepareTaskScript | undefined;
	/** Override the complete-result transport. Test seam. */
	resultRelay?: typeof executeWithResultRelayAsync;
	/**
	 * Inject a pre-built runner. When provided, the `credentials` argument to
	 * {@link OpenCloudBackend} is ignored — the injected runner already owns
	 * its own credentials. Intended primarily as a test seam.
	 *
	 * Both interfaces, not just {@link RemoteRunner}: this backend is the one
	 * that ships a run's code out of band, so the transport it needs is part of
	 * what a runner has to supply to serve it.
	 */
	runner?: (BinaryInputUploader & RemoteRunner) | undefined;
}

/** Runs tests as Open Cloud Luau tasks against an uploaded place version. */
export class OpenCloudBackend implements Backend {
	private readonly bootWatchMs: number;
	/**
	 * Kept so the upload cache can key on the universe and place it targets.
	 */
	private readonly credentials: OpenCloudCredentials;
	private readonly executionClaimObserver: Pick<ExecutionClaimObserver, "readAsync">;
	private readonly fileSystem: FileSystem;
	private readonly now: () => number;
	private readonly placeVersion: PlaceVersionGate;
	private readonly prepareScript: typeof prepareTaskScript;
	private readonly resultRelay: typeof executeWithResultRelayAsync;
	private readonly runner: BinaryInputUploader & RemoteRunner;

	/** This run's Code Bundle, absent for a run that ships the whole place. */
	private bundle!: BundleRun | undefined;
	/**
	 * Composed task scripts, keyed by the caller's own script. Work-stealing
	 * sends one script to every task in the pool and a static split sends one
	 * to every bucket, so without this the same split/splice/join runs once
	 * per task over a script that is megabytes on a real run.
	 */
	private composed!: Map<string, (claim: string) => string>;

	public readonly kind = "open-cloud" as const;
	public readonly placeInput = "built" as const;

	/**
	 * Create a backend for the given place.
	 * @param credentials - API key and the universe and place to run against.
	 * @param options - Overrides and test seams.
	 */
	constructor(credentials: OpenCloudCredentials, options?: OpenCloudOptions) {
		this.bootWatchMs = options?.bootWatchMs ?? DEFAULT_BOOT_WATCH_MS;
		this.prepareScript = options?.prepareScript ?? prepareTaskScript;
		this.credentials = credentials;
		this.executionClaimObserver =
			options?.executionClaimObserver ??
			new ExecutionClaimObserver({
				baseUrl: resolveOpenCloudBaseUrl(),
				credentials,
			});
		this.fileSystem = options?.fileSystem ?? nodeFileSystem;
		this.now = options?.now ?? Date.now;
		this.runner = options?.runner ?? new OcaleRunner(credentials, resolveRunnerOptions());
		this.resultRelay = options?.resultRelay ?? executeWithResultRelayAsync;
		this.placeVersion = new PlaceVersionGate({
			fileSystem: this.fileSystem,
			runner: this.runner,
		});
	}

	/**
	 * Upload or reuse the place version, prove it boots, then dispatch every job.
	 * @param options - Jobs and run settings.
	 * @returns Raw entries plus upload and execution timing.
	 */
	public async runTestsAsync(options: BackendOptions): Promise<BackendResult> {
		const progress = options.progress ?? NOOP_RUN_PROGRESS;
		this.beginRun(options.codeBundle, progress);
		const primary = resolvePrimaryJob(options);
		// timeout and bootProbeTimeout are picked from the first job — both are
		// per-run knobs, and one run boots one version of one place.
		const target = toCacheTarget(this.credentials, resolvePlaceFilePath(primary.config));

		const upload = await this.placeVersion.uploadOrReuseAsync({
			config: primary.config,
			progress,
			target,
		});
		const executionStart = Date.now();
		const outcome = await this.placeVersion.executeWithCachedUploadAsync(
			{ rootDirectory: primary.config.rootDir, target, upload },
			async (attempt) => {
				return this.bootAndDispatchAsync({
					options,
					primary,
					progress,
					target,
					upload: attempt,
				});
			},
		);

		return splitUploadAndExecution({
			executionStart,
			// Binary input uploads sit inside the execution window.
			extraUploadMs: this.bundle?.uploadMs ?? 0,
			outcome,
			uploadMs: upload.uploadMs,
		});
	}

	/**
	 * Clear everything one run holds, and say what its split left behind.
	 *
	 * Every field here is per-run rather than per-backend, and a second run on
	 * one instance must not inherit the first's bundle or composed scripts.
	 * @param codeBundle - Code Bundle of this run, if any.
	 * @param progress - Sink for the bundle stages.
	 */
	private beginRun(codeBundle: CodeBundleArtifact | undefined, progress: RunProgress): void {
		this.bundle = openBundleRun({
			artifact: codeBundle,
			fileSystem: this.fileSystem,
			now: this.now,
			progress,
			runner: this.runner,
		});
		this.composed = new Map();
	}

	/**
	 * One attempt against one place version: prove it boots, then run every job
	 * on it. A 404 on a reused version drops the cache entry and fails the run;
	 * the next run uploads afresh.
	 * @param options - Backend options, primary job, progress sink, place target and upload outcome.
	 * @returns Raw results of the dispatched jobs.
	 */
	private async bootAndDispatchAsync({
		options,
		primary,
		progress,
		target,
		upload,
	}: {
		/** Backend options of the run. */
		options: BackendOptions;
		/** First job; its config sets the per-run knobs. */
		primary: ProjectJob;
		/** Sink for the boot and tests stages. */
		progress: RunProgress;
		/** Upload-cache target of the place. */
		target: UploadCacheTarget;
		/** Upload outcome of this attempt. */
		upload: UploadOutcome;
	}): Promise<DispatchOutcome> {
		const isBootProven = await this.placeVersion.verifyBootAsync({
			config: primary.config,
			progress,
			target,
			upload,
		});
		// Keep the input's validity window available for dispatched test tasks.
		await this.bundle?.ensureInputAsync(
			openCloudExecutionBudgets(primary.config.timeout).inputValidityMs,
		);
		// Closed on success only: a dispatch that throws leaves the stage open,
		// and the reporter then names it as the step the run died inside.
		const done = progress.begin("tests", describeProjectCount(options.jobs.length));
		const outcome = await dispatchJobsAsync({
			...options,
			executeAsync: async (request) => this.executeAsync(request),
			primaryConfig: primary.config,
			version: {
				bootProven: isBootProven,
				versionNumber: upload.versionNumber,
			},
		});
		done();
		return outcome;
	}

	/**
	 * One logical execution. A Shared Place run creates exactly one task for
	 * it; only a Binary Input run, which nothing in production selects, may
	 * replace one under an execution claim.
	 * @param request - Script, timeout and the version to pin to.
	 * @returns Result of the task.
	 */
	private async executeAsync(request: {
		/** Luau script to run. */
		script: string;
		/** Task timeout, in milliseconds. */
		timeout: number;
		/** Version the task is pinned to. */
		version: VersionContext;
	}): Promise<ScriptResult> {
		if (this.bundle !== undefined) {
			return this.executeClaimedAsync(request);
		}

		const { script, timeout, version } = request;
		return this.runner
			.executeScriptAsync({
				bootProven: version.bootProven,
				placeVersion: version.versionNumber,
				script,
				timeout,
			})
			.catch(rethrowOversizedResult);
	}

	/**
	 * One logical execution under one execution claim. Every physical task it
	 * creates, replacements included, is pinned to the run's Exact Version.
	 * @param request - Script, timeout and the version to pin to.
	 * @returns Result of the task that held the claim.
	 */
	private async executeClaimedAsync({
		script,
		timeout,
		version,
	}: {
		/** Luau script to run. */
		script: string;
		/** Task timeout, in milliseconds. */
		timeout: number;
		/** Version the task is pinned to. */
		version: VersionContext;
	}): Promise<ScriptResult> {
		return executeWithRecoveryAsync({
			bootWatchMs: this.bootWatchMs,
			executeAsync: async ({ claim, observationSignal, submission }) => {
				return this.submitAsync({
					claim,
					observationSignal,
					onSubmitted: () => {
						submission.accepted();
					},
					script,
					timeout,
					version,
				});
			},
			now: this.now,
			readClaimAsync: this.executionClaimObserver.readAsync.bind(this.executionClaimObserver),
			startupWindowMs: openCloudExecutionBudgets(timeout).startupWindowMs,
			timeout,
			watchesSubmission: true,
		});
	}

	/**
	 * {@link prepareTaskScript}, once per script. See `composed`.
	 * @param script - Caller script to compose.
	 * @returns Composer that prefixes the script with a claim.
	 */
	private prepareOnce(script: string): (claim: string) => string {
		// The bundle is per-run and the map is cleared per run, so the script
		// alone is the key.
		const cached = this.composed.get(script);
		if (cached !== undefined) {
			return cached;
		}

		const composed = this.prepareScript({ script });
		this.composed.set(script, composed);
		return composed;
	}

	/**
	 * One submit, pinned to the run's Exact Version.
	 *
	 * A run carrying a code bundle always pairs its rebuild script with a
	 * current binary input, recovery submissions included.
	 * @param options - Claim, observation signal, submit callback, script, timeout and version.
	 * @returns Result of the task, read through the result relay.
	 */
	private async submitAsync({
		claim,
		observationSignal,
		onSubmitted,
		script,
		timeout,
		version,
	}: {
		/** Execution claim the script carries. */
		claim: string;
		/** Signal that stops observing the task. */
		observationSignal: AbortSignal;
		/** Called once the task create is accepted. */
		onSubmitted: () => void;
		/** Caller script to compose and run. */
		script: string;
		/** Task timeout, in milliseconds. */
		timeout: number;
		/** Version the task is pinned to. */
		version: VersionContext;
	}): Promise<ScriptResult> {
		const budgets = openCloudExecutionBudgets(timeout);
		const baseUrl = resolveOpenCloudBaseUrl();
		const binaryInput = await this.bundle?.ensureInputAsync(budgets.inputValidityMs);
		return this.resultRelay({
			...(baseUrl === undefined ? {} : { baseUrl }),
			credentials: this.credentials,
			executeAsync: async (wrapped, signal) => {
				return this.runner.executeScriptAsync({
					binaryInput,
					bootProven: version.bootProven,
					observationSignal: signal,
					onSubmitted,
					placeVersion: version.versionNumber,
					retrySubmitTransportErrors: false,
					script: wrapped,
					submitBudget: budgets.submitBudget,
					submitCapacityBudget: budgets.submitCapacityBudget,
					timeout,
				});
			},
			runtimeBudget: timeout,
			script: this.prepareOnce(script)(`${claim}\n`),
			signal: observationSignal,
			timeout: budgets.observationMs,
		}).catch(rethrowOversizedResult);
	}
}

/**
 * Create an {@link OpenCloudBackend}.
 * @param credentials - API key and the universe and place to run against.
 * @param options - Overrides and test seams.
 * @returns A backend that targets the given place.
 */
export function createOpenCloudBackend(
	credentials: OpenCloudCredentials,
	options: OpenCloudOptions = {},
): OpenCloudBackend {
	return new OpenCloudBackend(credentials, options);
}

function resolvePrimaryJob({
	jobs,
	scriptOverride,
	workStealing = false,
}: BackendOptions): ProjectJob {
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
 * Binary uploads occur inside the execution window; charge them to uploadMs.
 * @param options - Execution start, binary upload time, dispatch outcome and place upload time.
 * @returns The outcome with its timing.
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
