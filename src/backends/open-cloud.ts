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
import { generateTestScript, type JestArgvInput } from "../test-script.ts";
import type {
	Backend,
	BackendOptions,
	BackendResult,
	ProjectBackendResult,
	ProjectJob,
} from "./interface.ts";

const PARALLEL_AUTO_CAP = 3;

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

const entrySchema = type({
	"elapsedMs?": "number",
	"gameOutput?": "string",
	"jestOutput": "string",
});

const envelopeSchema = type({ entries: entrySchema.array() });

interface JobBucket {
	indices: Array<number>;
	jobs: Array<ProjectJob>;
}

export class OpenCloudBackend implements Backend {
	private readonly credentials: OpenCloudCredentials;
	private readonly http: HttpClient;
	private readonly readFile: FileReader;
	private readonly sleepFn: (ms: number) => Promise<void>;

	public readonly kind = "open-cloud" as const;

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
		const { jobs, parallel } = options;
		if (jobs.length === 0) {
			throw new Error("OpenCloudBackend requires at least one job");
		}

		// Cache/timeout/pollInterval are picked from the first job. All jobs in
		// a single CLI invocation share the same place file, so these are
		// per-run knobs rather than per-job.
		// eslint-disable-next-line ts/no-non-null-assertion -- length checked above
		const primary = jobs[0]!;
		const placeFilePath = path.resolve(primary.config.rootDir, primary.config.placeFile);
		const cacheDirectory = getCacheDirectory();
		const cacheFilePath = path.join(cacheDirectory, "upload-cache.json");

		// Place upload happens once per runTests call regardless of how many
		// sessions we fire. Hoisted above the bucket dispatch so --parallel does
		// not upload N times.
		const uploadStart = Date.now();
		const placeData = this.readFile(placeFilePath);
		const fileHash = hashBuffer(placeData);
		const cacheKey = getCacheKey(this.credentials.universeId, this.credentials.placeId);

		const cache = readCache(cacheFilePath);
		const uploadCached = await this.uploadOrReuseCached({
			cache,
			cacheEnabled: primary.config.cache,
			cacheFilePath,
			cacheKey,
			fileHash,
			placeData,
		});

		const uploadMs = Date.now() - uploadStart;

		const buckets = bucketJobs(jobs, parallel);

		const executionStart = Date.now();
		const bucketResults = await Promise.all(
			buckets.map(async (bucket) => this.runBucket(bucket)),
		);
		const executionMs = Date.now() - executionStart;

		// Flatten bucket results in original job order via the indices recorded
		// at bucketing time. indices and results always share the same length
		// because runBucket asserts that invariant before returning.
		const flattened: Array<ProjectBackendResult> = Array.from({ length: jobs.length });
		for (const { indices, results } of bucketResults) {
			for (const [positionInBucket, originalIndex] of indices.entries()) {
				// eslint-disable-next-line ts/no-non-null-assertion -- length invariant
				flattened[originalIndex] = results[positionInBucket]!;
			}
		}

		return {
			results: flattened,
			timing: { executionMs, uploadCached, uploadMs },
		};
	}

	private async createExecutionTask(
		inputs: Array<JestArgvInput>,
		timeoutMs: number,
	): Promise<string> {
		const url = `${OPEN_CLOUD_BASE_URL}/cloud/v2/universes/${this.credentials.universeId}/places/${this.credentials.placeId}/luau-execution-session-tasks`;

		const script = generateTestScript(inputs);

		const response = await this.http.request("POST", url, {
			body: {
				script,
				timeout: `${Math.floor(timeoutMs / 1000)}s`,
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

	private async runBucket(
		bucket: JobBucket,
	): Promise<{ indices: Array<number>; results: Array<ProjectBackendResult> }> {
		const { indices, jobs } = bucket;
		// A bucket is only created for at least one job, so jobs[0] is defined.
		// eslint-disable-next-line ts/no-non-null-assertion -- bucket non-empty
		const primary = jobs[0]!;
		const inputs: Array<JestArgvInput> = jobs.map((job) => {
			return { config: job.config, testFiles: job.testFiles };
		});

		const taskPath = await this.createExecutionTask(inputs, primary.config.timeout);
		const { gameOutput, jestOutput } = await this.pollForCompletion(
			taskPath,
			primary.config.timeout,
			primary.config.pollInterval,
		);

		const entries = parseEnvelope(jestOutput);
		if (entries.length !== jobs.length) {
			throw new Error(
				`Open Cloud backend returned ${entries.length.toString()} entries but bucket had ${jobs.length.toString()} jobs`,
			);
		}

		const results = entries.map((entry, index) => {
			// Length match has been asserted above, so the index is always in
			// range.
			// eslint-disable-next-line ts/no-non-null-assertion -- length asserted above
			return buildProjectResult(entry, jobs[index]!, gameOutput);
		});

		return { indices, results };
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

function parseEnvelope(jestOutput: string): Array<typeof entrySchema.infer> {
	// Legacy runtime error payloads (non-envelope-shaped) are re-wrapped as a
	// length-1 entries array so parseJestOutput can surface the original
	// LuauScriptError through buildProjectResult. Mirrors StudioBackend.
	const raw: unknown = JSON.parse(jestOutput);
	const envelope = envelopeSchema(raw);
	if (envelope instanceof type.errors) {
		return [{ elapsedMs: 0, jestOutput }];
	}

	return envelope.entries;
}

function buildProjectResult(
	entry: typeof entrySchema.infer,
	job: ProjectJob,
	fallbackGameOutput: string | undefined,
): ProjectBackendResult {
	const gameOutput = entry.gameOutput ?? fallbackGameOutput;

	let parsed;
	try {
		parsed = parseJestOutput(entry.jestOutput);
	} catch (err) {
		if (err instanceof LuauScriptError) {
			err.gameOutput = gameOutput;
		}

		throw err;
	}

	return {
		coverageData: parsed.coverageData,
		displayColor: job.displayColor,
		displayName: job.displayName,
		elapsedMs: entry.elapsedMs ?? 0,
		gameOutput,
		luauTiming: parsed.luauTiming,
		result: parsed.result,
		setupMs:
			parsed.setupSeconds !== undefined ? Math.round(parsed.setupSeconds * 1000) : undefined,
		snapshotWrites: parsed.snapshotWrites,
	};
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
