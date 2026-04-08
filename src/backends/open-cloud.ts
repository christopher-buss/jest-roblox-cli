import {
	createFetchClient,
	getCacheDirectory,
	getCacheKey,
	hashBuffer,
	isUploaded,
	markUploaded,
	readCache,
	writeCache,
} from "@isentinel/roblox-runner";
import type { HttpClient } from "@isentinel/roblox-runner";

import { type } from "arktype";
import type buffer from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import { LuauScriptError, parseJestOutput } from "../reporter/parser.ts";
import { generateTestScript } from "../test-script.ts";
import type { Backend, BackendOptions, BackendResult } from "./interface.ts";

const OPEN_CLOUD_BASE_URL = "https://apis.roblox.com";
const RATE_LIMIT_DEFAULT_WAIT_MS = 5000;
const MAX_RATE_LIMIT_RETRIES = 5;

export interface OpenCloudCredentials {
	apiKey: string;
	placeId: string;
	universeId: string;
}

export interface OpenCloudOptions {
	http?: HttpClient;
	readFile?: FileReader;
	sleep?: (ms: number) => Promise<void>;
}

type FileReader = (path: string) => buffer.Buffer;

const taskResponse = type({ path: "string" });

const taskStatusResponse = type({
	"error?": { "message?": "string" },
	"output?": { "results?": "string[]" },
	"state": "'CANCELLED' | 'COMPLETE' | 'FAILED' | 'PROCESSING'",
});

export class OpenCloudBackend implements Backend {
	private readonly credentials: OpenCloudCredentials;
	private readonly http: HttpClient;
	private readonly readFile: FileReader;
	private readonly sleepFn: (ms: number) => Promise<void>;

	constructor(credentials: OpenCloudCredentials, options?: OpenCloudOptions) {
		this.credentials = credentials;
		this.http =
			options?.http ??
			createFetchClient({
				"x-api-key": credentials.apiKey,
			});
		this.readFile = options?.readFile ?? ((filePath) => fs.readFileSync(filePath));
		this.sleepFn =
			options?.sleep ??
			(async (ms) => {
				return new Promise((resolve) => {
					setTimeout(resolve, ms);
				});
			});
	}

	public async runTests(options: BackendOptions): Promise<BackendResult> {
		const placeFilePath = path.resolve(options.config.rootDir, options.config.placeFile);
		const cacheDirectory = getCacheDirectory();
		const cacheFilePath = path.join(cacheDirectory, "upload-cache.json");

		const uploadStart = Date.now();
		const placeData = this.readFile(placeFilePath);
		const fileHash = hashBuffer(placeData);
		const cacheKey = getCacheKey(this.credentials.universeId, this.credentials.placeId);

		const cache = readCache(cacheFilePath);
		const uploadCached = await this.uploadOrReuseCached({
			cache,
			cacheEnabled: options.config.cache,
			cacheFilePath,
			cacheKey,
			fileHash,
			placeData,
		});

		const uploadMs = Date.now() - uploadStart;

		const executionStart = Date.now();
		const taskPath = await this.createExecutionTask(options);
		const { gameOutput, jestOutput } = await this.pollForCompletion(
			taskPath,
			options.config.timeout,
			options.config.pollInterval,
		);
		const executionMs = Date.now() - executionStart;

		let parsed;
		try {
			parsed = parseJestOutput(jestOutput);
		} catch (err) {
			if (err instanceof LuauScriptError) {
				err.gameOutput = gameOutput;
			}

			throw err;
		}

		const setupMs =
			parsed.setupSeconds !== undefined ? Math.round(parsed.setupSeconds * 1000) : undefined;

		return {
			coverageData: parsed.coverageData,
			gameOutput,
			luauTiming: parsed.luauTiming,
			result: parsed.result,
			setupMs,
			snapshotWrites: parsed.snapshotWrites,
			timing: { executionMs, uploadCached, uploadMs },
		};
	}

	private async createExecutionTask(options: BackendOptions): Promise<string> {
		const url = `${OPEN_CLOUD_BASE_URL}/cloud/v2/universes/${this.credentials.universeId}/places/${this.credentials.placeId}/luau-execution-session-tasks`;

		const script = generateTestScript(options);

		const response = await this.http.request("POST", url, {
			body: {
				script,
				timeout: `${Math.floor(options.config.timeout / 1000)}s`,
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
	): Promise<{ gameOutput?: string; jestOutput: string }> {
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
					const value = body.output?.results?.[0];
					if (value === undefined) {
						throw new Error(
							`No test results in output. Got: ${JSON.stringify(body.output)}`,
						);
					}

					return {
						gameOutput: body.output?.results?.[1],
						jestOutput: value,
					};
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

	private async uploadOrReuseCached({
		cache,
		cacheEnabled,
		cacheFilePath,
		cacheKey,
		fileHash,
		placeData,
	}: {
		cache: ReturnType<typeof readCache>;
		cacheEnabled: boolean;
		cacheFilePath: string;
		cacheKey: string;
		fileHash: string;
		placeData: buffer.Buffer;
	}): Promise<boolean> {
		if (cacheEnabled && isUploaded(cache, cacheKey, fileHash)) {
			return true;
		}

		await this.uploadPlaceData(placeData);
		markUploaded(cache, cacheKey, fileHash);
		writeCache(cacheFilePath, cache);

		return false;
	}

	private async uploadPlaceData(placeData: buffer.Buffer): Promise<void> {
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
	}
}

export function createOpenCloudBackend(): OpenCloudBackend {
	const apiKey = process.env["ROBLOX_OPEN_CLOUD_API_KEY"];
	if (apiKey === undefined) {
		throw new Error("ROBLOX_OPEN_CLOUD_API_KEY environment variable is required");
	}

	const universeId = process.env["ROBLOX_UNIVERSE_ID"];
	if (universeId === undefined) {
		throw new Error("ROBLOX_UNIVERSE_ID environment variable is required");
	}

	const placeId = process.env["ROBLOX_PLACE_ID"];
	if (placeId === undefined) {
		throw new Error("ROBLOX_PLACE_ID environment variable is required");
	}

	return new OpenCloudBackend({ apiKey, placeId, universeId });
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
