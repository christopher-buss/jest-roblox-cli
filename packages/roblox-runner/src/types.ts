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

export interface ExecuteScriptOptions {
	/**
	 * Tell the poll that this place version is already known to boot, so a
	 * task that never settles is not read as a place Roblox cannot load.
	 *
	 * That reading is the runner's fallback diagnosis, and it is the right one
	 * only while nothing better is known. A caller that has just run a script
	 * against this same version knows better, and leaving the guess in place
	 * would send the reader to Studio to inspect a place that demonstrably
	 * loads.
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
	timeout: number;
}

export interface ScriptResult {
	durationMs: number;
	outputs: Array<string>;
}

export interface RemoteRunner {
	executeScriptAsync(options: ExecuteScriptOptions): Promise<ScriptResult>;
	uploadPlaceAsync(options: UploadPlaceOptions): Promise<UploadPlaceResult>;
}
