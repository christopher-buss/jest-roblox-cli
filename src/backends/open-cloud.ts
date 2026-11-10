import { OcaleRunner } from "@isentinel/roblox-runner";
import type { RemoteRunner, RunnerCredentials, ScriptResult } from "@isentinel/roblox-runner";

import { randomUUID } from "node:crypto";

import { resolvePlaceFilePath } from "../config/resolved-config.ts";
import { prepareWorkStealingQueueAsync } from "../memory-store/work-stealing.ts";
import { NOOP_RUN_PROGRESS, type RunProgress } from "../progress/run-progress.ts";
import { describeProjectCount } from "../progress/stages.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { BackendOf, BackendResult } from "./interface.ts";
import { dispatchJobsAsync } from "./open-cloud-dispatch.ts";
import type { OpenCloudDispatch, StealingRequest, TaskRequest } from "./open-cloud-dispatch.ts";
import type { DispatchOutcome } from "./open-cloud-entries.ts";
import { resolveOpenCloudBaseUrl, resolveRunnerOptions } from "./open-cloud-environment.ts";
import { rethrowOversizedResult } from "./open-cloud-failures.ts";
import { PlaceVersionGate, toCacheTarget, type UploadOutcome } from "./open-cloud-place-version.ts";
import { type PreparedStealing, tryStealingDispatchAsync } from "./open-cloud-work-stealing.ts";
import type { UploadCacheTarget } from "./upload-cache.ts";

/** Optional overrides and test seams for {@link OpenCloudBackend}. */
export interface OpenCloudOptions {
	/** Where the place file is read from. Defaults to the real filesystem. */
	fileSystem?: FileSystem | undefined;
	/** ID generator for the work-stealing maps. Defaults to `randomUUID`. */
	generateUuid?: (() => string) | undefined;
	/** Work-stealing queue setup. Defaults to the real Open Cloud one. */
	prepareWorkStealingQueue?: typeof prepareWorkStealingQueueAsync | undefined;
	/** Pre-built runner; when set, the `credentials` argument is ignored. */
	runner?: RemoteRunner | undefined;
}

/** Runs tests as Open Cloud Luau tasks against an uploaded place version. */
export class OpenCloudBackend implements BackendOf<"open-cloud", OpenCloudDispatch> {
	private readonly credentials: RunnerCredentials;
	private readonly generateUuid: () => string;
	private readonly placeVersion: PlaceVersionGate;
	private readonly prepareWorkStealingQueue: typeof prepareWorkStealingQueueAsync;
	private readonly runner: RemoteRunner;

	public readonly kind = "open-cloud" as const;

	/**
	 * Create a backend for the given place.
	 * @param credentials - API key and the universe and place to run against.
	 * @param options - Overrides and test seams.
	 */
	constructor(credentials: RunnerCredentials, options?: OpenCloudOptions) {
		this.credentials = credentials;
		this.generateUuid = options?.generateUuid ?? randomUUID;
		this.prepareWorkStealingQueue =
			options?.prepareWorkStealingQueue ?? prepareWorkStealingQueueAsync;
		this.runner = options?.runner ?? new OcaleRunner(credentials, resolveRunnerOptions());
		this.placeVersion = new PlaceVersionGate({
			fileSystem: options?.fileSystem ?? nodeFileSystem,
			runner: this.runner,
		});
	}

	/**
	 * Upload or reuse the place version, prove it boots, then dispatch every job.
	 * @param request - Jobs, sharding and run config.
	 * @returns Raw entries plus upload and execution timing.
	 */
	public async runTestsAsync(request: OpenCloudDispatch): Promise<BackendResult> {
		const progress = request.progress ?? NOOP_RUN_PROGRESS;
		const { runSettings } = request;
		const target = toCacheTarget(this.credentials, resolvePlaceFilePath(runSettings));

		const upload = await this.placeVersion.uploadOrReuseAsync({
			config: runSettings,
			progress,
			target,
		});
		const executionStart = Date.now();
		const outcome = await this.placeVersion.executeWithCachedUploadAsync(
			{ rootDirectory: runSettings.rootDir, target, upload },
			async (attempt) => {
				return this.bootAndDispatchAsync({
					progress,
					request,
					target,
					upload: attempt,
				});
			},
		);

		return {
			...outcome,
			timing: {
				executionMs: Date.now() - executionStart,
				uploadMs: upload.uploadMs,
			},
		};
	}

	private async bootAndDispatchAsync({
		progress,
		request,
		target,
		upload,
	}: {
		/** Sink for the boot and tests stages. */
		progress: RunProgress;
		/** Dispatch request of the run. */
		request: OpenCloudDispatch;
		/** Upload-cache target of the place. */
		target: UploadCacheTarget;
		/** Upload outcome of this attempt. */
		upload: UploadOutcome;
	}): Promise<DispatchOutcome> {
		const isBootProven = await this.placeVersion.verifyBootAsync({
			config: request.runSettings,
			progress,
			target,
			upload,
		});
		const done = progress.begin("tests", describeProjectCount(request.jobs.length));
		const outcome = await dispatchJobsAsync({
			...request,
			executeAsync: async (task) => this.executeAsync(task),
			prepareStealingAsync: async (stealing) => this.prepareStealingAsync(stealing),
			version: {
				bootProven: isBootProven,
				versionNumber: upload.versionNumber,
			},
		});
		done();
		return outcome;
	}

	private async executeAsync({ script, timeout, version }: TaskRequest): Promise<ScriptResult> {
		return this.runner
			.executeScriptAsync({
				bootProven: version.bootProven,
				placeVersion: version.versionNumber,
				script,
				timeout,
			})
			.catch(rethrowOversizedResult);
	}

	private async prepareStealingAsync(
		stealing: StealingRequest,
	): Promise<PreparedStealing | undefined> {
		return tryStealingDispatchAsync({
			...stealing,
			credentials: {
				apiKey: this.credentials.apiKey,
				baseUrl: resolveOpenCloudBaseUrl(),
				universeId: this.credentials.universeId,
			},
			generateUuid: this.generateUuid,
			prepareWorkStealingQueue: this.prepareWorkStealingQueue,
		});
	}
}
