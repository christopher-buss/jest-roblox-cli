import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { buildRunPayload, type RunPayload, type RunPayloadRequest } from "./plugin-payload.ts";

/**
 * Plugin/CLI protocol version, carried in the Run-mode payload. Matches
 * `STUDIO_PROTOCOL_VERSION` in the WebSocket `studio` backend and
 * `PROTOCOL_VERSION` in the plugin. The bootstrap echoes the version the
 * run-mode runner returns; `assertProtocolMatch` rejects a plugin that
 * omits the echo (a stale runner predating the handshake) or returns a
 * different number, surfacing a clean "update the plugin" error.
 */
export const STUDIO_CLI_PROTOCOL_VERSION = 10;

type StudioCliPayload = RunPayload & {
	/**
	 * The Managed Plugin that must serve the run; absent when none was
	 * installed.
	 */
	pluginKey?: string;
	protocolVersion: typeof STUDIO_CLI_PROTOCOL_VERSION;
	test: true;
};

/**
 * Seconds the bootstrap keeps its result socket alive after sending, waiting
 * to be closed/killed by the host. A backstop only: the host kills Studio the
 * instant it receives the result, so the bootstrap is normally terminated
 * mid-wait. Long enough to never truncate a send, short enough that a host
 * that vanished doesn't wedge Studio open.
 */
const SOCKET_LINGER_SECONDS = 30;

const RUN_SIDE_CHANNEL_ATTRIBUTE = "JestRobloxRunSideChannel";

const BOOTSTRAP_FILE = "bootstrap.server.luau";
const OUTPUT_FILE = "output.log";

/**
 * Bootstrap epilogue: open the localhost result socket (`URL`) and push the
 * encoded frame, then keep the script — and the socket — alive until the host
 * receives it and kills us, or the linger backstop elapses. Static, so it is
 * built once: everything run-specific lives in the prologue this is appended
 * to. See {@link SOCKET_LINGER_SECONDS}.
 */
const BOOTSTRAP_SEND_LINES = [
	"local encoded = HttpService:JSONEncode(message)",
	"local connected, socket = pcall(function()",
	"\treturn HttpService:CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, { Url = URL })",
	"end)",
	"if not connected then",
	'\tprint("studio-cli: failed to open result socket: " .. tostring(socket))',
	"\treturn",
	"end",
	"local finished = false",
	"socket.Opened:Once(function()",
	"\tsocket:Send(encoded)",
	"end)",
	"socket.Error:Once(function(_statusCode, errorMessage)",
	'\tprint("studio-cli: result socket error: " .. tostring(errorMessage))',
	"\tfinished = true",
	"end)",
	"socket.Closed:Once(function()",
	"\tfinished = true",
	"end)",
	"local start = os.clock()",
	`while not finished and (keepAlive or os.clock() - start < ${SOCKET_LINGER_SECONDS.toString()}) do`,
	"\ttask.wait(0.05)",
	"end",
];

/**
 * Bootstrap hand-off of the payload to the play session, read when
 * `ExecuteRunModeAsync` returns nil. A failure is printed and the run goes on.
 */
const BOOTSTRAP_SIDE_CHANNEL_LINES = [
	"local sideChannelSet, sideChannelError = pcall(function()",
	`\tReplicatedStorage:SetAttribute("${RUN_SIDE_CHANNEL_ATTRIBUTE}", HttpService:JSONEncode({ payload = payload, requestId = REQUEST_ID, url = URL }))`,
	"end)",
	"if not sideChannelSet then",
	'\tprint("studio-cli: failed to set the run side channel: " .. tostring(sideChannelError))',
	"end",
];

/**
 * Bootstrap start report: a `started` frame on its own socket, sent without
 * waiting. A failure is printed so the boot timeout's log tail names it.
 */
const BOOTSTRAP_STARTED_LINES = [
	"local startedOpened, startedSocket = pcall(function()",
	"\treturn HttpService:CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, { Url = URL })",
	"end)",
	"if startedOpened then",
	"\tstartedSocket.Opened:Once(function()",
	'\t\tstartedSocket:Send(HttpService:JSONEncode({ type = "started", requestId = REQUEST_ID }))',
	"\tend)",
	"\tstartedSocket.Error:Once(function(_statusCode, errorMessage)",
	'\t\tprint("studio-cli: start socket error: " .. tostring(errorMessage))',
	"\tend)",
	"else",
	'\tprint("studio-cli: failed to open start socket: " .. tostring(startedSocket))',
	"end",
];

/** The place a run opens, plus where its scratch files are written. */
export interface RunPlace {
	/** Whether this is a workspace run — picks the bootstrap payload shape. */
	isWorkspace: boolean;
	/** Absolute path of the place Studio opens. */
	placeFile: string;
	/** `.jest-roblox/studio-cli` scratch directory for this run. */
	workDirectory: string;
}

interface StudioArgsOptions extends RunPayloadRequest, RunPlace {
	/** File system the bootstrap script is written to. */
	fileSystem: FileSystem;
	/** Managed Plugin that must serve the run; undefined when none. */
	pluginKey: string | undefined;
	/** Localhost port of the result WebSocket. */
	port: number;
	/** Id that ties the result frame to this run. */
	requestId: string;
}

/**
 * Where Studio is told to write its engine log for a run.
 *
 * @param workDirectory - The run's scratch directory.
 * @returns The log file path.
 */
export function studioOutputFile(workDirectory: string): string {
	return path.join(workDirectory, OUTPUT_FILE);
}

/**
 * Write the run's bootstrap script into the work directory and return the
 * Studio CLI argument vector that opens the place and runs it.
 *
 * @param options - Jobs, place, work directory, socket port, request id, and
 *   plugin key.
 * @returns The Studio argument vector, without the executable.
 * @throws {@link Error} When a workspace job has no package name.
 */
export function buildStudioArgs({
	bail,
	fileSystem,
	jobs,
	placeFile,
	pluginKey,
	port,
	requestId,
	runBudgetMs,
	vmParallel,
	workDirectory,
}: StudioArgsOptions): Array<string> {
	const bootstrapFile = path.join(workDirectory, BOOTSTRAP_FILE);
	const outputFile = studioOutputFile(workDirectory);
	fileSystem.writeFileSync(
		bootstrapFile,
		buildBootstrap({
			payload: buildStudioCliPayload({ bail, jobs, runBudgetMs, vmParallel }, pluginKey),
			port,
			requestId,
		}),
	);

	return [
		"--task",
		"RunScript",
		"--localPlaceFile",
		normalizeWindowsPath(placeFile),
		"--runScriptFile",
		normalizeWindowsPath(bootstrapFile),
		"--outputFile",
		normalizeWindowsPath(outputFile),
		"--quitAfterExecution",
	];
}

function buildStudioCliPayload(
	request: RunPayloadRequest,
	pluginKey: string | undefined,
): StudioCliPayload {
	return {
		...(pluginKey === undefined ? {} : { pluginKey }),
		protocolVersion: STUDIO_CLI_PROTOCOL_VERSION,
		test: true,
		...buildRunPayload(request),
	};
}

/**
 * Wrap `content` in a Luau long string, escalating the bracket level
 * (`[=[`, `[==[`, …) until the chosen `]=*]` terminator does not occur in the
 * content. Without this, a config string carrying the level-1 terminator
 * `]=]` (a `testNamePattern`, for example) would close the string early and
 * emit syntactically invalid Luau — a silent no-result run.
 *
 * @param content - Text to wrap.
 * @returns A Luau long string literal.
 */
function luauLongString(content: string): string {
	let level = 1;
	while (content.includes(`]${"=".repeat(level)}]`)) {
		level += 1;
	}

	const eq = "=".repeat(level);
	return `[${eq}[${content}]${eq}]`;
}

/**
 * Bootstrap prologue: decode the payload, drive the plugin's Run-mode runner
 * via `ExecuteRunModeAsync`, and assemble the `message` frame — a plugin
 * that threw or returned a non-result yields a `{ success = false }`
 * envelope, and a nil return sends `nilReturn` and keeps the socket alive.
 *
 * @param options - Payload, socket port, and request id.
 * @returns The Luau source lines.
 */
function bootstrapRunLines({
	payload,
	port,
	requestId,
}: {
	readonly payload: StudioCliPayload;
	readonly port: number;
	readonly requestId: string;
}): Array<string> {
	return [
		'local HttpService = game:GetService("HttpService")',
		'local ReplicatedStorage = game:GetService("ReplicatedStorage")',
		'local StudioTestService = game:GetService("StudioTestService")',
		`local payload = HttpService:JSONDecode(${luauLongString(JSON.stringify(payload))})`,
		`local URL = "ws://localhost:${port.toString()}"`,
		`local REQUEST_ID = ${luauLongString(requestId)}`,
		...BOOTSTRAP_SIDE_CHANNEL_LINES,
		...BOOTSTRAP_STARTED_LINES,
		"local ok, result = pcall(function()",
		"\treturn StudioTestService:ExecuteRunModeAsync(payload)",
		"end)",
		"local message",
		"local keepAlive = false",
		"if not ok then",
		'\tmessage = { type = "results", requestId = REQUEST_ID, gameOutput = "[]", jestOutput = HttpService:JSONEncode({ err = tostring(result), success = false }) }',
		"elseif result == nil then",
		"\t-- Remove this keep-alive branch once Roblox fixes",
		"\t-- https://devforum.roblox.com/t/executerunmodeasync-returns-nil-when-called-from-task-runscript-before-the-place-reaches-placeidle/4921336",
		'\tmessage = { type = "nilReturn", requestId = REQUEST_ID }',
		"\tkeepAlive = true",
		'elseif typeof(result) ~= "table" or result.jestOutput == nil then',
		'\tmessage = { type = "results", requestId = REQUEST_ID, gameOutput = "[]", jestOutput = HttpService:JSONEncode({ err = "studio-cli: the jest plugin produced no result. Install or update the jest-roblox Studio plugin.", success = false }) }',
		"else",
		'\tmessage = { type = "results", requestId = REQUEST_ID, protocolVersion = result.protocolVersion, pluginVersion = result.pluginVersion, gameOutput = result.gameOutput or "[]", jestOutput = result.jestOutput }',
		"end",
	];
}

/**
 * The `--runScriptFile` script. Runs at command-bar level in the edit
 * DataModel, drives the installed plugin's Run-mode runner via
 * `ExecuteRunModeAsync`, then pushes the result envelope back to the host over
 * a localhost WebSocket (`HttpService:CreateWebStreamClient`, the same client
 * API the plugin uses). `requestId` correlates the frame with this run. A
 * plugin that is absent or returns nothing sends a `{ success = false }`
 * envelope, so the host surfaces a clean error rather than hanging.
 *
 * @param options - Payload, socket port, and request id.
 * @returns The Luau script source.
 */
function buildBootstrap({
	payload,
	port,
	requestId,
}: {
	readonly payload: StudioCliPayload;
	readonly port: number;
	readonly requestId: string;
}): string {
	return [...bootstrapRunLines({ payload, port, requestId }), ...BOOTSTRAP_SEND_LINES, ""].join(
		"\n",
	);
}
