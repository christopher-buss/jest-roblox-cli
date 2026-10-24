import type { LuauExecutionClient } from "@bedrock-rbx/ocale/luau-execution";
import type { PlacesClient, PublishParameters } from "@bedrock-rbx/ocale/places";

import type buffer from "node:buffer";

import { createPlacePayload } from "./file-system.ts";
import { describeStatus, describeUploadFailure } from "./poll-diagnosis.ts";
import type {
	RunnerCredentials,
	UploadBinaryInputOptions,
	UploadBinaryInputResult,
	UploadPlaceOptions,
	UploadPlaceResult,
} from "./runner-types.ts";

interface UploadAdapters {
	credentials: RunnerCredentials;
	fetch: typeof globalThis.fetch;
	luau: LuauExecutionClient;
	places: PlacesClient;
	readFile: (filePath: string) => buffer.Buffer;
}
const UPLOAD_RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

/**
 * Upload places and binary inputs through their respective SDK and storage
 * transports.
 */
export class CloudUploads {
	private readonly options: UploadAdapters;

	/**
	 * Bind uploads to their SDK, file and presigned-PUT adapters.
	 * @param options - Credentials, SDK clients, file reader and PUT transport.
	 */
	constructor(options: UploadAdapters) {
		this.options = options;
	}

	/**
	 * Allocate with the SDK; PUT bytes only to its returned storage URI.
	 * @param options - Binary bytes to allocate and PUT to storage.
	 * @returns Accepted binary-input resource path and elapsed upload time.
	 * @rejects When slot allocation or the presigned upload fails.
	 */
	public async uploadBinaryInputAsync({
		payload,
	}: UploadBinaryInputOptions): Promise<UploadBinaryInputResult> {
		const uploadStart = Date.now();
		const created = await this.options.luau.binaryInputs.create({
			size: payload.byteLength,
			universeId: this.options.credentials.universeId,
		});
		if (!created.success) {
			throw new Error(
				`Failed to allocate a binary input slot${describeStatus(created.err)}: ${created.err.message}`,
				{ cause: created.err },
			);
		}

		const response = await this.options.fetch(created.data.uploadUri, {
			body: payload,
			method: "PUT",
		});
		if (!response.ok) {
			throw new Error(
				`Failed to PUT the binary input (HTTP ${String(response.status)}): ${await response.text()}`,
			);
		}

		return { path: created.data.path, uploadMs: Date.now() - uploadStart };
	}

	/**
	 * Save or publish place bytes and return the accepted version.
	 * @param options - Place file path and save-or-publish selection.
	 * @returns Accepted place version and elapsed upload time.
	 * @rejects When the place file cannot be read or its upload is refused.
	 */
	public async uploadPlaceAsync(options: UploadPlaceOptions): Promise<UploadPlaceResult> {
		const uploadStart = Date.now();
		const { parameters, placeFilePath } = this.createPlaceParameters(options.placeFilePath);
		// Do not add codes here: an override replaces ocale's defaults and stops
		// GATEWAY_REJECTED retries.
		const result =
			options.publish === true
				? await this.options.places.publish(parameters, {
						retryableStatuses: UPLOAD_RETRYABLE_STATUSES,
					})
				: await this.options.places.save(parameters, {
						retryableStatuses: UPLOAD_RETRYABLE_STATUSES,
					});
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

	private createPlaceParameters(placeFilePath: string): {
		parameters: PublishParameters;
		placeFilePath: string;
	} {
		const { body, filePath, format } = createPlacePayload({
			placeFilePath,
			readFile: this.options.readFile,
		});
		return {
			parameters: {
				body,
				format,
				placeId: this.options.credentials.placeId,
				universeId: this.options.credentials.universeId,
			},
			placeFilePath: filePath,
		};
	}
}
