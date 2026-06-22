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
	 * Pin execution to a specific place version (the `versionNumber` returned
	 * by {@link RemoteRunner.uploadPlace}). Open Cloud Luau Execution otherwise
	 * boots whatever version is currently live, so a concurrent upload to the
	 * same place clobbers an in-flight run; pinning isolates each run to the
	 * version it uploaded. Omitted ⇒ run against the live (head) version.
	 */
	placeVersion?: number;
	script: string;
	timeout: number;
}

export interface ScriptResult {
	durationMs: number;
	outputs: Array<string>;
}

export interface RemoteRunner {
	executeScript(options: ExecuteScriptOptions): Promise<ScriptResult>;
	uploadPlace(options: UploadPlaceOptions): Promise<UploadPlaceResult>;
}
