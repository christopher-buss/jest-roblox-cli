import type { HttpClient, OpenCloudError, Result, SleepFunc } from "@bedrock-rbx/ocale";
import {
	ApiError,
	NetworkError,
	PollTimeoutError,
	TRANSIENT_TRANSPORT_CODES,
} from "@bedrock-rbx/ocale";
import type { LuauExecutionTask } from "@bedrock-rbx/ocale/luau-execution";
import { LuauExecutionClient } from "@bedrock-rbx/ocale/luau-execution";
import type { PublishParameters } from "@bedrock-rbx/ocale/places";
import { PlacesClient } from "@bedrock-rbx/ocale/places";

import type buffer from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";

import type {
	ExecuteScriptOptions,
	RemoteRunner,
	RunnerCredentials,
	ScriptResult,
	UploadPlaceOptions,
	UploadPlaceResult,
} from "./types.ts";

const MAX_TASK_TIMEOUT_SECONDS = 300;

/**
 * Statuses a place upload retries. Wider than ocale's upload default of `[429]`
 * alone, which guards against a 5xx that describes a write that partly landed.
 * A duplicate place version is not a hazard here: Roblox dedupes identical
 * place content, so a retry that races an upload which did land returns that
 * same version. Roblox's own 502 (`Request Context Failure`) is frequent enough
 * that surfacing it fails a test run for a fault that clears on the next
 * attempt.
 */
const UPLOAD_RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

export interface OcaleRunnerOptions {
	baseUrl?: string;
	httpClient?: HttpClient;
	/**
	 * Max retry attempts the underlying Open Cloud client makes per request.
	 * Defaults to the client's own default (3). Raising it lets place uploads
	 * and task submits ride out a transient 429 throttle (the server's
	 * `retry-after` is honored) instead of surfacing the rate limit — useful
	 * when many runs share one place's per-minute upload quota.
	 */
	maxRetries?: number;
	readFile?: (filePath: string) => buffer.Buffer;
	sleep?: SleepFunc;
}

export class OcaleRunner implements RemoteRunner {
	private readonly credentials: RunnerCredentials;
	private readonly luau: LuauExecutionClient;
	private readonly places: PlacesClient;
	private readonly readFileFn: (filePath: string) => buffer.Buffer;

	constructor(credentials: RunnerCredentials, options?: OcaleRunnerOptions) {
		this.credentials = credentials;
		const clientOptions = {
			apiKey: credentials.apiKey,
			...(options?.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
			...(options?.httpClient !== undefined ? { httpClient: options.httpClient } : {}),
			...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
			...(options?.sleep !== undefined ? { sleep: options.sleep } : {}),
		};
		this.luau = new LuauExecutionClient(clientOptions);
		this.places = new PlacesClient(clientOptions);
		this.readFileFn = options?.readFile ?? ((filePath) => fs.readFileSync(filePath));
	}

	public async executeScriptAsync({
		placeVersion,
		script,
		timeout,
	}: ExecuteScriptOptions): Promise<ScriptResult> {
		if (timeout <= 0) {
			throw new Error("Timeout must be a positive number");
		}

		const startTime = Date.now();
		const timeoutSeconds = Math.min(Math.floor(timeout / 1000), MAX_TASK_TIMEOUT_SECONDS);

		const result = await this.luau.tasks.runUntilDone(
			{
				placeId: this.credentials.placeId,
				script,
				timeoutSeconds,
				universeId: this.credentials.universeId,
				...(placeVersion !== undefined ? { versionId: String(placeVersion) } : {}),
			},
			{
				retryableTransportCodes: TRANSIENT_TRANSPORT_CODES,
				timeoutMs: timeout,
			},
		);

		return toScriptResult(result, startTime);
	}

	public async uploadPlaceAsync(options: UploadPlaceOptions): Promise<UploadPlaceResult> {
		const placeFilePath = path.resolve(options.placeFilePath);
		const uploadStart = Date.now();
		const placeData = this.readFileFn(placeFilePath);

		const parameters: PublishParameters = {
			body: toArrayBufferView(placeData),
			format: deriveFormat(placeFilePath),
			placeId: this.credentials.placeId,
			universeId: this.credentials.universeId,
		};
		// Only the statuses are overridden. ocale's upload defaults already carry
		// every transient transport code plus `GATEWAY_REJECTED`, and a
		// per-request list replaces the default rather than extending it, so
		// naming the codes here would drop gateway-rejection retry.
		const requestOptions = { retryableStatuses: UPLOAD_RETRYABLE_STATUSES };
		const result =
			options.publish === true
				? await this.places.publish(parameters, requestOptions)
				: await this.places.save(parameters, requestOptions);
		if (!result.success) {
			throw new Error(
				`Failed to upload place ${placeFilePath}: ${describeUploadFailure(result.err)}`,
				{ cause: result.err },
			);
		}

		return {
			uploadMs: Date.now() - uploadStart,
			versionNumber: result.data.versionNumber,
		};
	}
}

/**
 * Expands an upload failure into one diagnostic line. An `ApiError` carries
 * the failing call and how long it was in flight, and a bare `err.message`
 * throws all of that away: `HTTP 502: Request Context Failure` alone says
 * nothing about which request died, or whether it died on the wire or after
 * 30 seconds of upload.
 *
 * @param err - The Open Cloud error the upload returned.
 * @returns The error message, followed by the request context ocale captured.
 */
function describeUploadFailure(err: OpenCloudError): string {
	if (!(err instanceof ApiError) && !(err instanceof NetworkError)) {
		return err.message;
	}

	const target = err.url === undefined ? "" : ` on ${err.method} ${err.url}`;
	const elapsed =
		err instanceof ApiError && err.elapsedMs !== undefined
			? ` after ${(err.elapsedMs / 1000).toFixed(1)}s`
			: "";
	return `${err.message}${target}${elapsed}`;
}

function coerceOutputToString(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	// Bedrock's wire-parsed output.results is JSONValue (no undefined, function,
	// or symbol entries), so JSON.stringify always returns a string here. The
	// outer `String()` satisfies the union return type without adding a branch.
	return String(JSON.stringify(value));
}

function toScriptResult(
	result: Result<LuauExecutionTask, OpenCloudError>,
	startTime: number,
): ScriptResult {
	if (!result.success) {
		if (result.err instanceof PollTimeoutError) {
			throw new Error("Execution timed out", { cause: result.err });
		}

		throw new Error(result.err.message, { cause: result.err });
	}

	const task = result.data;
	if (task.state === "COMPLETE") {
		return {
			durationMs: Date.now() - startTime,
			outputs: task.output.results.map(coerceOutputToString),
		};
	}

	if (task.state === "FAILED") {
		throw new Error(task.error.message);
	}

	throw new Error("Execution was cancelled");
}

function toArrayBufferView(data: buffer.Buffer): Uint8Array<ArrayBuffer> {
	const view = new Uint8Array(data.byteLength);
	view.set(data);
	return view;
}

function deriveFormat(filePath: string): "rbxl" | "rbxlx" {
	return path.extname(filePath).toLowerCase() === ".rbxlx" ? "rbxlx" : "rbxl";
}
