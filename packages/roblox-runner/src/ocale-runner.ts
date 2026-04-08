/* cspell:words ocale */
import { type } from "arktype";
import type buffer from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	getCacheDirectory,
	getCacheKey,
	isUploaded,
	markUploaded,
	readCache,
	writeCache,
} from "./cache.ts";
import { hashBuffer } from "./hash.ts";
import { createFetchClient } from "./http-client.ts";
import type { HttpClient } from "./http-client.ts";
import type {
	ExecuteScriptOptions,
	RemoteRunner,
	RunnerCredentials,
	ScriptResult,
	UploadPlaceOptions,
	UploadPlaceResult,
} from "./types.ts";

const OPEN_CLOUD_BASE_URL = "https://apis.roblox.com";
const RATE_LIMIT_DEFAULT_WAIT_MS = 5000;
const MAX_RATE_LIMIT_RETRIES = 5;
const DEFAULT_POLL_INTERVAL_MS = 2000;

export interface OcaleRunnerOptions {
	http?: HttpClient;
	readFile?: (filePath: string) => buffer.Buffer;
	sleep?: (ms: number) => Promise<void>;
}

const taskResponse = type({ path: "string" });

const taskStatusResponse = type({
	"error?": { "message?": "string" },
	"output?": { "results?": "string[]" },
	"state": "'CANCELLED' | 'COMPLETE' | 'FAILED' | 'PROCESSING'",
});

export class OcaleRunner implements RemoteRunner {
	private readonly credentials: RunnerCredentials;
	private readonly http: HttpClient;
	private readonly readFileFn: (filePath: string) => buffer.Buffer;
	private readonly sleepFn: (ms: number) => Promise<void>;

	constructor(credentials: RunnerCredentials, options?: OcaleRunnerOptions) {
		this.credentials = credentials;
		this.http =
			options?.http ??
			createFetchClient({
				"x-api-key": credentials.apiKey,
			});
		this.readFileFn = options?.readFile ?? ((filePath) => fs.readFileSync(filePath));
		this.sleepFn =
			options?.sleep ??
			(async (ms) => {
				return new Promise((resolve) => {
					setTimeout(resolve, ms);
				});
			});
	}

	public async executeScript(options: ExecuteScriptOptions): Promise<ScriptResult> {
		if (options.timeout <= 0) {
			throw new Error("Timeout must be a positive number");
		}

		const pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
		const startTime = Date.now();

		const taskPath = await this.createExecutionTask(options.script, options.timeout);
		const outputs = await this.pollForCompletion(taskPath, options.timeout, pollInterval);

		return {
			durationMs: Date.now() - startTime,
			outputs,
		};
	}

	public async uploadPlace(options: UploadPlaceOptions): Promise<UploadPlaceResult> {
		const placeFilePath = path.resolve(options.placeFilePath);
		const cacheDirectory = getCacheDirectory();
		const cacheFilePath = path.join(cacheDirectory, "upload-cache.json");

		const uploadStart = Date.now();
		const placeData = this.readFileFn(placeFilePath);
		const fileHash = hashBuffer(placeData);
		const cacheKey = getCacheKey(this.credentials.universeId, this.credentials.placeId);

		const cache = readCache(cacheFilePath);
		const cacheEnabled = options.cache ?? false;

		if (cacheEnabled && isUploaded(cache, cacheKey, fileHash)) {
			return {
				cached: true,
				uploadMs: Date.now() - uploadStart,
				versionNumber: 0,
			};
		}

		const versionNumber = await this.uploadPlaceData(placeData);
		markUploaded(cache, cacheKey, fileHash);
		writeCache(cacheFilePath, cache);

		return {
			cached: false,
			uploadMs: Date.now() - uploadStart,
			versionNumber,
		};
	}

	private async createExecutionTask(script: string, timeoutMs: number): Promise<string> {
		const url = `${OPEN_CLOUD_BASE_URL}/cloud/v2/universes/${this.credentials.universeId}/places/${this.credentials.placeId}/luau-execution-session-tasks`;

		// OCALE API caps task timeout at 300s
		const taskTimeoutSeconds = Math.min(Math.floor(timeoutMs / 1000), 300);

		const response = await this.http.request("POST", url, {
			body: {
				script,
				timeout: `${taskTimeoutSeconds}s`,
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to create execution task: ${response.status}`);
		}

		const body = taskResponse.assert(response.body);
		return body.path;
	}

	private async pollForCompletion(
		taskPath: string,
		timeoutMs: number,
		pollIntervalMs: number,
	): Promise<Array<string>> {
		const url = `${OPEN_CLOUD_BASE_URL}/cloud/v2/${taskPath}`;
		const startTime = Date.now();
		let rateLimitRetries = 0;

		while (Date.now() - startTime < timeoutMs) {
			const response = await this.http.request("GET", url);

			if (response.status === 429) {
				rateLimitRetries++;
				if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
					throw new Error("Rate limited by Open Cloud API after multiple retries");
				}

				const retryAfter = parseRetryAfter(response.headers);
				await this.sleepFn(retryAfter);
				continue;
			}

			if (!response.ok) {
				throw new Error(`Failed to poll task: ${response.status}`);
			}

			const body = taskStatusResponse.assert(response.body);

			switch (body.state) {
				case "COMPLETE": {
					return body.output?.results ?? [];
				}
				case "FAILED": {
					throw new Error(body.error?.message ?? "Execution failed");
				}
				case "CANCELLED": {
					throw new Error("Execution was cancelled");
				}
				case "PROCESSING": {
					await this.sleepFn(pollIntervalMs);
					break;
				}
			}
		}

		throw new Error("Execution timed out");
	}

	private async uploadPlaceData(placeData: buffer.Buffer): Promise<number> {
		const url = `${OPEN_CLOUD_BASE_URL}/universes/v1/${this.credentials.universeId}/places/${this.credentials.placeId}/versions?versionType=Saved`;

		const response = await this.http.request("POST", url, {
			body: placeData,
			headers: {
				"Content-Type": "application/octet-stream",
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to upload place: ${response.status}`);
		}

		const { body } = response;
		if (typeof body === "object" && body !== null && "versionNumber" in body) {
			const version = Number((body as { versionNumber: unknown }).versionNumber);
			if (!Number.isNaN(version)) {
				return version;
			}
		}

		throw new Error("Upload succeeded but response is missing versionNumber");
	}
}

function parseRetryAfter(headers?: Record<string, string | undefined>): number {
	const value = headers?.["retry-after"];
	if (value === undefined) {
		return RATE_LIMIT_DEFAULT_WAIT_MS;
	}

	const seconds = Number(value);
	if (Number.isNaN(seconds) || seconds <= 0) {
		return RATE_LIMIT_DEFAULT_WAIT_MS;
	}

	return seconds * 1000;
}
