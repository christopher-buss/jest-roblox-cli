export interface RunnerCredentials {
	apiKey: string;
	placeId: string;
	universeId: string;
}

export interface UploadPlaceOptions {
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

export interface UploadPlaceResult {
	uploadMs: number;
	versionNumber: number;
}

export interface UploadBinaryInputOptions {
	/**
	 * The bytes the task will read back as a `buffer` from its first argument.
	 */
	payload: Uint8Array;
}

export interface UploadBinaryInputResult {
	/**
	 * Resource path of the input, as `binaryInputs.create` named it. Pass it
	 * verbatim as {@link ExecuteScriptOptions.binaryInput}.
	 */
	path: string;
	/** Wall time of the slot allocation and the PUT together. */
	uploadMs: number;
}

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
	 * Pin execution to a specific place version (the `versionNumber` returned
	 * by {@link RemoteRunner.uploadPlaceAsync}). Open Cloud Luau Execution
	 * otherwise boots whatever version is currently live, so a concurrent
	 * upload to the same place clobbers an in-flight run; pinning isolates each
	 * run to the version it uploaded. Omitted ⇒ run against the live (head)
	 * version.
	 */
	placeVersion?: number;
	/**
	 * Wall-clock cap on the poll, in milliseconds, replacing the default of
	 * the task deadline plus a boot-lag allowance.
	 *
	 * The default budget is built to outlast the deadline so Roblox's own
	 * verdict on a script that overran is observable. A caller asking a
	 * wall-clock question instead — "did this place boot at all?" — wants no
	 * such allowance: past the budget there is nothing left to wait for, and
	 * the grace only delays the answer.
	 */
	pollBudget?: number;
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
	timeout: number;
}

/** Authoritative evidence that the task which produced a result has stopped. */
export interface TerminalTaskEvidence {
	ref: {
		sessionId: string | undefined;
		taskId: string;
	};
	state: "COMPLETE";
}

export interface ScriptResult {
	durationMs: number;
	outputs: Array<string>;
	terminalTask?: TerminalTaskEvidence;
}

export interface RemoteRunner {
	executeScriptAsync(options: ExecuteScriptOptions): Promise<ScriptResult>;
	uploadPlaceAsync(options: UploadPlaceOptions): Promise<UploadPlaceResult>;
}

/**
 * A runner that can hand a task a payload out of band. Kept apart from
 * {@link RemoteRunner} because a consumer that only boots whole places has no
 * use for it, and the transport it names — a presigned PUT at a slot the
 * client allocates — is Open Cloud's, not a property of every runner.
 */
export interface BinaryInputUploader {
	uploadBinaryInputAsync(options: UploadBinaryInputOptions): Promise<UploadBinaryInputResult>;
}
