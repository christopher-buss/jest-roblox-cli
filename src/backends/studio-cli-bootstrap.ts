import * as path from "node:path";
import type { Except } from "type-fest";

import { encodeRunFailure, luauRunFailure } from "../protocol/envelope.ts";
import { luauLongString } from "../protocol/long-string.ts";
import {
	RUN_SIDE_CHANNEL_ATTRIBUTE,
	STUDIO_FRAME,
	STUDIO_PROTOCOL_VERSION,
} from "../protocol/studio.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { buildRunPayload, type RunPayload, type RunPayloadRequest } from "./plugin-payload.ts";

type StudioCliPayload = RunPayload & {
	pluginKey?: string;
	protocolVersion: typeof STUDIO_PROTOCOL_VERSION;
	test: true;
};

const SOCKET_LINGER_SECONDS = 30;

const NO_RESULT_MESSAGE =
	"studio-cli: the jest plugin produced no result. Install or update the jest-roblox Studio plugin.";

const BOOTSTRAP_FILE = "bootstrap.server.luau";
const OUTPUT_FILE = "output.log";

const OPEN_RETRY_INTERVAL_SECONDS = 0.25;

const OPEN_RETRY_LIMIT_SECONDS = 10;

const BOOTSTRAP_SOCKET_LINES = [
	"local socket = nil",
	"local socketOpen = false",
	"local socketClosed = false",
	"local outbox = {}",
	"local function connect(label)",
	"\tlocal openStart = os.clock()",
	"\tlocal opened, client",
	"\twhile true do",
	"\t\topened, client = pcall(function()",
	"\t\t\treturn HttpService:CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, { Url = URL })",
	"\t\tend)",
	`\t\tif opened or os.clock() - openStart >= ${OPEN_RETRY_LIMIT_SECONDS.toString()} then`,
	"\t\t\tbreak",
	"\t\tend",
	`\t\ttask.wait(${OPEN_RETRY_INTERVAL_SECONDS.toString()})`,
	"\tend",
	"\tif not opened then",
	'\t\tprint("studio-cli: failed to open " .. label .. " socket: " .. tostring(client))',
	"\t\treturn false",
	"\tend",
	"\tsocket = client",
	"\tsocketOpen = false",
	"\tsocketClosed = false",
	"\toutbox = {}",
	"\tclient.Opened:Once(function()",
	"\t\tif socket ~= client then",
	"\t\t\treturn",
	"\t\tend",
	"\t\tsocketOpen = true",
	"\t\tfor _, encoded in outbox do",
	"\t\t\tclient:Send(encoded)",
	"\t\tend",
	"\t\toutbox = {}",
	"\tend)",
	"\tclient.Error:Once(function(_statusCode, errorMessage)",
	'\t\tprint("studio-cli: " .. label .. " socket error: " .. tostring(errorMessage))',
	"\t\tif socket == client then",
	"\t\t\tsocketClosed = true",
	"\t\tend",
	"\tend)",
	"\tclient.Closed:Once(function()",
	"\t\tif socket == client then",
	"\t\t\tsocketClosed = true",
	"\t\tend",
	"\tend)",
	"\treturn true",
	"end",
	"local function send(encoded)",
	"\tif socketOpen then",
	"\t\tsocket:Send(encoded)",
	"\telse",
	"\t\ttable.insert(outbox, encoded)",
	"\tend",
	"end",
];

const BOOTSTRAP_SEND_LINES = [
	"if not socketOpen or socketClosed then",
	"\tif socket ~= nil then",
	"\t\tpcall(function()",
	"\t\t\tsocket:Close()",
	"\t\tend)",
	"\tend",
	'\tif not connect("result") then',
	"\t\treturn",
	"\tend",
	"end",
	"send(HttpService:JSONEncode(message))",
	"local start = os.clock()",
	`while not socketClosed and (keepAlive or os.clock() - start < ${SOCKET_LINGER_SECONDS.toString()}) do`,
	"\ttask.wait(0.05)",
	"end",
];

// Read by the play session when `ExecuteRunModeAsync` returns nil.
const BOOTSTRAP_SIDE_CHANNEL_LINES = [
	"local sideChannelSet, sideChannelError = pcall(function()",
	`\tReplicatedStorage:SetAttribute("${RUN_SIDE_CHANNEL_ATTRIBUTE}", HttpService:JSONEncode({ payload = payload, requestId = REQUEST_ID, url = URL }))`,
	"end)",
	"if not sideChannelSet then",
	'\tprint("studio-cli: failed to set the run side channel: " .. tostring(sideChannelError))',
	"end",
];

const BOOTSTRAP_STARTED_LINES = [
	'if connect("start") then',
	`\tsend(HttpService:JSONEncode({ type = "${STUDIO_FRAME.started}", requestId = REQUEST_ID }))`,
	"end",
];

/** The place a run opens, plus where its scratch files are written. */
export interface RunPlace {
	/** Absolute path of the place Studio opens. */
	placeFile: string;
	/** `.jest-roblox/studio-cli` scratch directory for this run. */
	workDirectory: string;
}

interface StudioArgsOptions extends Except<RunPayloadRequest, "runtimeStubs">, RunPlace {
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
 * Write the run's bootstrap script and return the Studio argument vector.
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
	workspace,
}: StudioArgsOptions): Array<string> {
	const bootstrapFile = path.join(workDirectory, BOOTSTRAP_FILE);
	const outputFile = studioOutputFile(workDirectory);
	fileSystem.writeFileSync(
		bootstrapFile,
		buildBootstrap({
			payload: buildStudioCliPayload(
				{ bail, jobs, runBudgetMs, runtimeStubs: false, vmParallel, workspace },
				pluginKey,
			),
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
		protocolVersion: STUDIO_PROTOCOL_VERSION,
		test: true,
		...buildRunPayload(request),
	};
}

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
		...BOOTSTRAP_SOCKET_LINES,
		...BOOTSTRAP_STARTED_LINES,
		"local ok, result = pcall(function()",
		"\treturn StudioTestService:ExecuteRunModeAsync(payload)",
		"end)",
		"local message",
		"local keepAlive = false",
		"if not ok then",
		`\tmessage = { type = "${STUDIO_FRAME.results}", requestId = REQUEST_ID, gameOutput = "[]", jestOutput = HttpService:JSONEncode(${luauRunFailure("tostring(result)")}) }`,
		"elseif result == nil then",
		"\t-- Remove this keep-alive branch once Roblox fixes",
		"\t-- https://devforum.roblox.com/t/executerunmodeasync-returns-nil-when-called-from-task-runscript-before-the-place-reaches-placeidle/4921336",
		`\tmessage = { type = "${STUDIO_FRAME.nilReturn}", requestId = REQUEST_ID }`,
		"\tkeepAlive = true",
		'elseif typeof(result) ~= "table" or result.jestOutput == nil then',
		`\tmessage = { type = "${STUDIO_FRAME.results}", requestId = REQUEST_ID, gameOutput = "[]", jestOutput = ${luauLongString(encodeRunFailure(NO_RESULT_MESSAGE))} }`,
		"else",
		`\tmessage = { type = "${STUDIO_FRAME.results}", requestId = REQUEST_ID, protocolVersion = result.protocolVersion, pluginVersion = result.pluginVersion, gameOutput = result.gameOutput or "[]", jestOutput = result.jestOutput }`,
		"end",
	];
}

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
