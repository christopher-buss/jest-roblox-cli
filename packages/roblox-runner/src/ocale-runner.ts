import type { HttpClient, SleepFunc } from "@bedrock-rbx/ocale";
import { PollTimeoutError, TRANSIENT_TRANSPORT_CODES } from "@bedrock-rbx/ocale";
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

export interface OcaleRunnerOptions {
	baseUrl?: string;
	httpClient?: HttpClient;
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
			...(options?.sleep !== undefined ? { sleep: options.sleep } : {}),
		};
		this.luau = new LuauExecutionClient(clientOptions);
		this.places = new PlacesClient(clientOptions);
		this.readFileFn = options?.readFile ?? ((filePath) => fs.readFileSync(filePath));
	}

	public async executeScript(options: ExecuteScriptOptions): Promise<ScriptResult> {
		const { placeVersion, script, timeout } = options;
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

	public async uploadPlace(options: UploadPlaceOptions): Promise<UploadPlaceResult> {
		const placeFilePath = path.resolve(options.placeFilePath);
		const uploadStart = Date.now();
		const placeData = this.readFileFn(placeFilePath);

		const parameters: PublishParameters = {
			body: toArrayBufferView(placeData),
			format: deriveFormat(placeFilePath),
			placeId: this.credentials.placeId,
			universeId: this.credentials.universeId,
		};
		const requestOptions = { retryableTransportCodes: TRANSIENT_TRANSPORT_CODES };
		const result =
			options.publish === true
				? await this.places.publish(parameters, requestOptions)
				: await this.places.save(parameters, requestOptions);
		if (!result.success) {
			throw new Error(`Failed to upload place: ${result.err.message}`, {
				cause: result.err,
			});
		}

		return {
			uploadMs: Date.now() - uploadStart,
			versionNumber: result.data.versionNumber,
		};
	}
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

function toArrayBufferView(data: buffer.Buffer): Uint8Array<ArrayBuffer> {
	const view = new Uint8Array(data.byteLength);
	view.set(data);
	return view;
}

function deriveFormat(filePath: string): "rbxl" | "rbxlx" {
	return path.extname(filePath).toLowerCase() === ".rbxlx" ? "rbxlx" : "rbxl";
}
