export interface RunnerCredentials {
	apiKey: string;
	placeId: string;
	universeId: string;
}

export interface UploadPlaceOptions {
	placeFilePath: string;
	/**
	 * Publish as the live version instead of a Saved draft. Open Cloud Luau
	 * Execution boots the live Published version on fresh and recycled servers,
	 * so a Saved-only upload can be ignored mid-run when a warm server recycles.
	 */
	publish?: boolean;
}

export interface UploadPlaceResult {
	uploadMs: number;
	versionNumber: number;
}

export interface ExecuteScriptOptions {
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
