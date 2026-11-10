import { type Type, type } from "arktype";

/**
 * Plugin/CLI protocol version. Bump when the runtime contract between the CLI
 * and the Studio plugin changes; a plugin that speaks another version is never
 * dispatched to.
 */
export const STUDIO_PROTOCOL_VERSION = 12;

/** WebSocket port the attached `studio` backend listens on by default. */
export const DEFAULT_STUDIO_PORT = 3001;

/**
 * ReplicatedStorage attribute that names the port the plugin dials, for a CLI
 * configured off {@link DEFAULT_STUDIO_PORT}.
 */
export const STUDIO_PORT_ATTRIBUTE = "JEST_ROBLOX_PORT";

/**
 * ReplicatedStorage attribute the studio-cli bootstrap hands its payload on.
 */
export const RUN_SIDE_CHANNEL_ATTRIBUTE = "JestRobloxRunSideChannel";

/** The WebSocket action that asks the plugin to run a payload. */
export const RUN_TESTS_ACTION = "run_tests";

/**
 * One config of a Studio configs run.
 *
 * @template Argv - The Jest argv the config runs with.
 */
export interface StudioConfigEntry<Argv> {
	/** Jest argv of the config. */
	config: Argv;
	/**
	 * DataModel paths that get a runtime `jest.config` stub for this config.
	 */
	runtimeStubMounts: Array<string>;
}

/** How many `Actor` hosts the Studio plugin ships. */
export const VM_HOST_POOL_SIZE = 4;

/** Plugin child module that returns the Plugin Key of a Managed Plugin. */
export const PLUGIN_KEY_MODULE = "pluginKey";

/** Plugin child module that returns the plugin's release version. */
export const PLUGIN_VERSION_MODULE = "version";

/** Attribute a plugin VM host sets once it can take a slice. */
export const VM_HOST_READY_ATTRIBUTE = "JestRobloxVmHostReady";

/** The `type` of each frame on the Studio sockets. */
export const STUDIO_FRAME: {
	readonly hello: "hello";
	readonly nilRelay: "nilRelay";
	readonly nilReturn: "nilReturn";
	readonly pluginReady: "pluginReady";
	readonly results: "results";
	readonly started: "started";
	readonly versionMismatch: "version_mismatch";
} = {
	hello: "hello",
	nilRelay: "nilRelay",
	nilReturn: "nilReturn",
	pluginReady: "pluginReady",
	results: "results",
	started: "started",
	versionMismatch: "version_mismatch",
};

/** Seconds the run-mode plugin waits for the play server to start running. */
export const RUNNING_WAIT_SECONDS = 10;

/**
 * Milliseconds the CLI waits after a nil `ExecuteRunModeAsync` return for a
 * run-mode plugin to take the run over. Sits between
 * {@link RUNNING_WAIT_SECONDS} and {@link NIL_RELAY_WAIT_SECONDS}.
 */
export const NIL_RETURN_PLUGIN_WAIT_MS = 30_000;

/** Seconds the run-mode plugin waits for test args or a `nilRelay` frame. */
export const NIL_RELAY_WAIT_SECONDS = 60;

/**
 * The frame a plugin sends as soon as its socket opens. `pluginVersion` and
 * `pluginName` are diagnostic only.
 */
export interface HelloFrame {
	/** Name of the plugin copy. */
	pluginName?: string | undefined;
	/** Release the plugin copy was built from. */
	pluginVersion?: string | undefined;
	/** Protocol version the plugin speaks. */
	protocolVersion: number;
	/** Frame discriminator. */
	type: typeof STUDIO_FRAME.hello;
}

/** The result of a run. */
export interface ResultsFrame {
	/** Captured game output, as JSON. */
	gameOutput?: string;
	/** The encoded result envelope. */
	jestOutput: string;
	/** Plugin Key of the copy that ran. */
	pluginKey?: string;
	/** Release the plugin copy was built from. */
	pluginVersion?: string;
	/** Protocol version the plugin speaks; absent from a stale plugin. */
	protocolVersion?: number;
	/** Correlation id of the run. */
	requestId: string;
	/** Frame discriminator. */
	type: typeof STUDIO_FRAME.results;
}

/** A plugin's refusal of a request for another protocol version. */
export interface VersionMismatchFrame {
	/** Protocol version the plugin speaks. */
	actualVersion: number;
	/** Protocol version the request asked for. */
	expectedVersion: number;
	/** Correlation id of the run. */
	requestId: string;
	/** Frame discriminator. */
	type: typeof STUDIO_FRAME.versionMismatch;
}

interface RequestFrame<Kind extends string> {
	requestId: string;
	type: Kind;
}

export const helloFrameSchema: Type<HelloFrame> = type({
	"pluginName?": "string",
	"pluginVersion?": "string",
	"protocolVersion": "number",
	"type": "'hello'",
});

export const resultsFrameSchema: Type<ResultsFrame> = type({
	"gameOutput?": "string",
	"jestOutput": "string",
	"pluginKey?": "string",
	"pluginVersion?": "string",
	"protocolVersion?": "number",
	"requestId": "string",
	"type": "'results'",
});

export const versionMismatchFrameSchema: Type<VersionMismatchFrame> = type({
	actualVersion: "number",
	expectedVersion: "number",
	requestId: "string",
	type: "'version_mismatch'",
});

/** The studio-cli bootstrap's report that the run started. */
export const startedFrameSchema: Type<RequestFrame<typeof STUDIO_FRAME.started>> = type({
	requestId: "string",
	type: "'started'",
});

/** The bootstrap's report that `ExecuteRunModeAsync` returned nil. */
export const nilReturnFrameSchema: Type<RequestFrame<typeof STUDIO_FRAME.nilReturn>> = type({
	requestId: "string",
	type: "'nilReturn'",
});

/** A run-mode plugin's report that its socket to the CLI is open. */
export const pluginReadyFrameSchema: Type<RequestFrame<typeof STUDIO_FRAME.pluginReady>> = type({
	requestId: "string",
	type: "'pluginReady'",
});

/**
 * The frame that asks a ready run-mode plugin to run the side-channel payload.
 *
 * @param requestId - Correlation id of the run.
 * @returns The encoded frame.
 */
export function encodeNilRelayFrame(requestId: string): string {
	return JSON.stringify({ requestId, type: STUDIO_FRAME.nilRelay });
}
