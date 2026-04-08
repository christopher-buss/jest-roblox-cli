export interface RunnerCredentials {
	apiKey: string;
	placeId: string;
	universeId: string;
}

export interface UploadPlaceOptions {
	cache?: boolean;
	placeFilePath: string;
}

export interface UploadPlaceResult {
	cached: boolean;
	uploadMs: number;
	versionNumber: number;
}

export interface ExecuteScriptOptions {
	pollInterval?: number;
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
