import type { RemoteRunner, RunnerCredentials } from "@isentinel/roblox-runner";

import process from "node:process";

import type { RunProgress } from "../progress/run-progress.ts";
import { describePlaceFile } from "../progress/stages.ts";
import { BOOT_PROBE_SCRIPT } from "../protocol/open-cloud.ts";
import { isPollTimeout } from "../utils/error-chain.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { RunSettings } from "./interface.ts";
import { isNotFoundError } from "./open-cloud-failures.ts";
import type { UploadCacheTarget } from "./upload-cache.ts";
import {
	hashPlaceFile,
	invalidateCachedVersion,
	readCachedVersion,
	writeCachedVersion,
} from "./upload-cache.ts";

const BOOT_PROBE_TASK_TIMEOUT_MS = 10_000;

/** The Exact Version every task in this run is submitted to. */
export interface VersionContext {
	/** True when this run's probe completed on the uploaded version. */
	bootProven: boolean;
	/** Exact Version every task is submitted to. */
	versionNumber: number;
}

/** Result of uploading the place or reusing a cached version. */
export interface UploadOutcome {
	/** True when the version came from the cache instead of a fresh upload. */
	fromCache: boolean;
	/** Hash of the uploaded place bytes; undefined when there is no cache. */
	hash: string | undefined;
	/** Time spent on the upload or cache lookup, in milliseconds. */
	uploadMs: number;
	/** Place version that holds this run's place bytes. */
	versionNumber: number;
}

/** Uploads the place once per byte content and proves the version boots. */
export class PlaceVersionGate {
	private readonly fileSystem: FileSystem;
	private readonly runner: RemoteRunner;

	/**
	 * Create a gate over the given file system and runner.
	 * @param options - File system for the upload cache and the remote runner.
	 */
	constructor({
		fileSystem,
		runner,
	}: {
		/** File system that holds the upload cache. */
		fileSystem: FileSystem;
		/** Runner that uploads places and executes scripts. */
		runner: RemoteRunner;
	}) {
		this.fileSystem = fileSystem;
		this.runner = runner;
	}

	/**
	 * Clear a suspect upload-cache entry without restarting dispatched work.
	 * @param options - Cache location and the upload outcome to pass on.
	 * @param executeAsync - Work to run against the upload outcome.
	 * @returns What `executeAsync` resolves to.
	 * @rejects Whatever `executeAsync` rejects with; a 404 on a cached version also clears the cache entry.
	 */
	public async executeWithCachedUploadAsync<T>(
		{
			rootDirectory,
			target,
			upload,
		}: {
			/** Root directory that holds the upload cache. */
			rootDirectory: string;
			/** Place the cache entry belongs to. */
			target: UploadCacheTarget;
			/** Upload outcome passed to `executeAsync`. */
			upload: UploadOutcome;
		},
		executeAsync: (uploadOutcome: UploadOutcome) => Promise<T>,
	): Promise<T> {
		try {
			return await executeAsync(upload);
		} catch (err) {
			if (!upload.fromCache || !isNotFoundError(err)) {
				throw err;
			}

			process.stderr.write(
				"Warning: Open Cloud returned 404; clearing the upload cache without restarting dispatched tests.\n",
			);
			invalidateCachedVersion({ fileSystem: this.fileSystem, rootDirectory, target });
			throw err;
		}
	}

	/**
	 * Upload the place, or reuse the version that holds these exact bytes.
	 * Never writes the cache: only `verifyBootAsync` may record an entry.
	 * @param options - Run config, progress sink and place target.
	 * @returns The cached or freshly uploaded version.
	 */
	public async uploadOrReuseAsync({
		config,
		progress,
		target,
	}: {
		/** Run config; `uploadCache` turns the cache on. */
		config: RunSettings;
		/** Sink for the upload stage. */
		progress: RunProgress;
		/** Place to upload. */
		target: UploadCacheTarget;
	}): Promise<UploadOutcome> {
		const start = Date.now();
		const { fileSystem } = this;
		const { rootDir: rootDirectory, uploadCache: canCache } = config;
		const hash = canCache ? hashPlaceFile(target.placeFilePath, fileSystem) : undefined;
		if (hash !== undefined) {
			const cached = readCachedVersion({ fileSystem, hash, rootDirectory, target });
			if (cached !== undefined) {
				progress.note("upload", `cache hit, version ${cached.toString()}`);
				return {
					fromCache: true,
					hash,
					uploadMs: Date.now() - start,
					versionNumber: cached,
				};
			}
		}

		const done = progress.begin("upload", describePlaceFile(target.placeFilePath, fileSystem));
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
	 * Gate the tests on a probe of the uploaded version, and cache that proof.
	 * @param options - Run config, progress sink, place target and upload outcome.
	 * @returns True when a probe proved the version boots; false when the probe was skipped.
	 * @rejects {Error} When no probe booted the uploaded version.
	 */
	public async verifyBootAsync({
		config,
		progress,
		target,
		upload,
	}: {
		/** Run config; `bootProbeTimeout` of 0 skips the probe. */
		config: RunSettings;
		/** Sink for the boot stage. */
		progress: RunProgress;
		/** Place the cache entry belongs to. */
		target: UploadCacheTarget;
		/** Upload outcome to probe. */
		upload: UploadOutcome;
	}): Promise<boolean> {
		const budget = config.bootProbeTimeout;
		if (budget === 0 || upload.fromCache) {
			return false;
		}

		const done = progress.begin("boot", `version ${upload.versionNumber.toString()}`);
		const booted = await this.probeBootAsync({ budget, upload });
		if (booted !== String(upload.versionNumber)) {
			const reason =
				booted === undefined
					? `no boot probe completed within ${String(Math.round(budget / 1000))}s`
					: `the boot probe reported ${JSON.stringify(booted)}`;
			throw new Error(
				`Place version ${String(upload.versionNumber)} is boot unverified: ${reason}. No tests were submitted.`,
			);
		}

		done();
		if (upload.hash !== undefined) {
			writeCachedVersion({
				entry: {
					hash: upload.hash,
					versionNumber: upload.versionNumber,
				},
				fileSystem: this.fileSystem,
				rootDirectory: config.rootDir,
				target,
			});
		}

		return true;
	}

	private async probeBootAsync(options: {
		/** Poll budget of each probe, in milliseconds. */
		budget: number;
		/** Upload outcome to probe. */
		upload: UploadOutcome;
	}): Promise<string | undefined> {
		return (
			(await this.submitBootProbeAsync(options)) ?? (await this.submitBootProbeAsync(options))
		);
	}

	private async submitBootProbeAsync({
		budget,
		upload,
	}: {
		/** Poll budget of the probe, in milliseconds. */
		budget: number;
		/** Upload outcome to probe. */
		upload: UploadOutcome;
	}): Promise<string | undefined> {
		try {
			const result = await this.runner.executeScriptAsync({
				placeVersion: upload.versionNumber,
				pollBudget: budget,
				script: BOOT_PROBE_SCRIPT,
				timeout: Math.min(BOOT_PROBE_TASK_TIMEOUT_MS, budget),
			});
			return result.outputs[0] ?? "";
		} catch (err) {
			if (!isPollTimeout(err)) {
				throw err;
			}

			return undefined;
		}
	}
}

/**
 * Identify the upload-cache entry of a place file.
 * @param credentials - Credentials that name the universe and place.
 * @param placeFilePath - Built place whose bytes the entry tracks.
 * @returns Cache target for the place file.
 */
export function toCacheTarget(
	credentials: RunnerCredentials,
	placeFilePath: string,
): UploadCacheTarget {
	return {
		placeFilePath,
		placeId: credentials.placeId,
		universeId: credentials.universeId,
	};
}
