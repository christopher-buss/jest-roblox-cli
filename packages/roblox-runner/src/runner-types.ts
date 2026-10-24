import type { OpenCloudConnection } from "./client-options.ts";

/**
 * Credentials bind all operations to one universe and place.
 */
export interface RunnerCredentials extends Pick<OpenCloudConnection, "apiKey" | "universeId"> {
	/**
	 * Place resource ID within the selected universe.
	 */
	readonly placeId: string;
}

/**
 * Place upload input and publication choice.
 */
export interface UploadPlaceOptions {
	/**
	 * Binary or XML place file; XML is selected by the .rbxlx extension.
	 */
	placeFilePath: string;
	/**
	 * Publish as the live version instead of a Saved draft. Open Cloud Luau
	 * Execution boots whatever version is currently live on fresh and recycled
	 * servers, so without version pinning a concurrent upload can be picked up
	 * mid-run when a warm server recycles. Pinning execution to the uploaded
	 * version (see {@link ExecuteScriptOptions.placeVersion}) removes that
	 * hazard, so a Saved upload plus a pinned run isolates concurrent runs
	 * without disturbing the live slot — making this flag moot for that path.
	 */
	publish?: boolean;
}

/**
 * Accepted place version and host upload duration.
 */
export interface UploadPlaceResult {
	/**
	 * Host elapsed upload time in milliseconds.
	 */
	uploadMs: number;
	/**
	 * Version returned by the place upload, suitable for a pinned submission.
	 */
	versionNumber: number;
}

/**
 * Bytes to upload through a presigned binary-input slot.
 */
export interface UploadBinaryInputOptions {
	/**
	 * The bytes the task will read back as a `buffer` from its first argument.
	 */
	payload: Uint8Array;
}

/**
 * Accepted binary-input path and host upload duration.
 */
export interface UploadBinaryInputResult {
	/**
	 * Resource path of the input, as `binaryInputs.create` named it. Pass it
	 * verbatim as {@link ExecuteScriptOptions.binaryInput}.
	 */
	path: string;
	/** Wall time of the slot allocation and the PUT together. */
	uploadMs: number;
}

/**
 * Execution identity, source and independent host observation budgets.
 */
export interface ExecuteScriptOptions {
	/**
	 * Resource path an uploader returned (see {@link BinaryInputUploader}),
	 * which hands the task a payload it reads as a `buffer` rather than one
	 * baked into its script. One input is valid for fifteen minutes and can
	 * back every task of a run, whichever version each task binds.
	 *
	 * Explicitly `undefined` as well as absent: a caller that ships no bundle
	 * holds the value rather than the key, and the submit body omits the field
	 * either way — so no caller has to strip it back out before spreading.
	 */
	binaryInput?: string | undefined;
	/**
	 * Include a successful same-version probe in timeout diagnostics. This
	 * proves that probe ran, not whether the current task started or finished.
	 */
	bootProven?: boolean;
	/**
	 * Retry transient HTTP 5xx responses from task creation. Enable only when
	 * repeating the script is safe and every successful attempt produces an
	 * interchangeable result. An execution claim alone does not ensure that.
	 */
	isSubmitIdempotent?: boolean;
	/** Stop host polling without cancelling the remote Roblox execution. */
	observationSignal?: AbortSignal;
	/** Called after Open Cloud accepts the task and before polling starts. */
	onSubmitted?: () => void;
	/**
	 * Pin execution to a specific place version (the `versionNumber` returned
	 * by {@link RemoteRunner.uploadPlaceAsync}). Open Cloud Luau Execution
	 * otherwise boots whatever version is currently live, so a concurrent
	 * upload to the same place clobbers an in-flight run; pinning isolates each
	 * run to the version it uploaded. Omitted ⇒ run against the live (head)
	 * version.
	 */
	placeVersion?: number;
	/**
	 * Wall-clock cap on the task, in milliseconds, replacing the default of
	 * the task deadline plus a boot-lag allowance. Without a `submitBudget`,
	 * the submit and the poll share it, counted from the submit.
	 *
	 * The default budget is built to outlast the deadline so Roblox's own
	 * verdict on a script that overran is observable. A caller asking a
	 * wall-clock question instead — "did this place boot at all?" — wants no
	 * such allowance: past the budget there is nothing left to wait for, and
	 * the grace only delays the answer.
	 */
	pollBudget?: number;
	/**
	 * Retry task-create transport failures whose response may have been lost
	 * after Open Cloud accepted the task. Defaults to `true`. Disable when the
	 * caller resolves ambiguous creates at a higher layer.
	 */
	retrySubmitTransportErrors?: boolean;
	/**
	 * Luau source executed in the selected place.
	 */
	script: string;
	/**
	 * Wall-clock cap on the submit, in milliseconds, covering every rate-limit
	 * retry inside it. Omitted ⇒ the submit runs to the client's retry budget,
	 * however long that takes.
	 *
	 * A task create is the one call that answers a 429 by sleeping: Open Cloud
	 * meters creates per key, so a key several runs share refuses on a window
	 * this run did not fill and cannot shorten. The retry that waits it out is
	 * what a caller wants — but counted in attempts rather than seconds it has
	 * no upper bound in time, and the stage sits silent for as long as the
	 * server keeps saying "later". A budget converts that into a failure with
	 * a number on it.
	 *
	 * The trade is a submit abandoned in flight: the request may still land and
	 * consume a task slot nobody polls. Set it only where a duplicate task is
	 * cheaper than a stage that never returns.
	 */
	submitBudget?: number;
	/**
	 * Extra time for capacity, quota and SDK admission waits or task turnover.
	 * Omitted keeps `submitBudget` as the complete submission bound.
	 */
	submitCapacityBudget?: number;
	/**
	 * Requested execution timeout in milliseconds; the host clamps it when it
	 * resolves budgets.
	 */
	timeout: number;
}

/** Authoritative evidence that the task which produced a result has stopped. */
export interface TerminalTaskEvidence {
	/**
	 * Original task reference; recovery never submits another task.
	 */
	ref: {
		sessionId: string | undefined;
		taskId: string;
	};
	/**
	 * Only COMPLETE constitutes terminal success evidence.
	 */
	state: "COMPLETE";
}

/**
 * Backend outputs with host timing and optional terminal evidence.
 */
export interface ScriptResult {
	/**
	 * Host elapsed execution time in milliseconds, including submission.
	 */
	durationMs: number;
	/**
	 * Each returned JSON value is serialized to one string.
	 */
	outputs: Array<string>;
	/**
	 * Terminal success evidence retained when the backend supplies it.
	 */
	terminalTask?: TerminalTaskEvidence;
}

/**
 * Place upload and execution interface shared by remote backends.
 */
export interface RemoteRunner {
	/**
	 * Submit once and observe until a terminal result or host deadline.
	 *
	 * @param options - Script identity, submission policy and independent observation budgets.
	 * @returns Serialized outputs and total elapsed host execution time.
	 */
	executeScriptAsync(options: ExecuteScriptOptions): Promise<ScriptResult>;
	/**
	 * Save or publish place bytes and return the accepted version.
	 *
	 * @param options - Place file path and save-or-publish selection.
	 * @returns Accepted place version and elapsed upload time.
	 */
	uploadPlaceAsync(options: UploadPlaceOptions): Promise<UploadPlaceResult>;
}

/**
 * A runner that can hand a task a payload out of band. Kept apart from
 * {@link RemoteRunner} because a consumer that only boots whole places has no
 * use for it, and the transport it names — a presigned PUT at a slot the
 * client allocates — is Open Cloud's, not a property of every runner.
 */
export interface BinaryInputUploader {
	/**
	 * Allocate and upload bytes outside the script-source request.
	 * @param options - Binary input payload.
	 * @returns Accepted resource path and upload time.
	 */
	uploadBinaryInputAsync(options: UploadBinaryInputOptions): Promise<UploadBinaryInputResult>;
}
