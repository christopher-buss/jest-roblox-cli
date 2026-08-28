import { type } from "arktype";
import type buffer from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import { resolvePlaceFilePath } from "../config/schema.ts";
import type { BuildManifestArtifact } from "../coverage-pipeline/build-manifest.ts";
import { findRojoProject } from "../coverage-pipeline/prepare.ts";
import { NOOP_RUN_PROGRESS } from "../progress/reporter.ts";
import { describeProjectCount } from "../progress/stages.ts";
import {
	type BuildPlaceOptions,
	buildPlace as defaultBuildPlace,
} from "../staging/place-builder.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { decodeEnvelope } from "./envelope.ts";
import {
	type Backend,
	type BackendOptions,
	type BackendResult,
	isWorkspaceRun,
	type ProjectJob,
	type RawBackendEntry,
} from "./interface.ts";
import { buildRunPayload, type RunPayload, type RunPayloadRequest } from "./plugin-payload.ts";
import { discoverStudioPath } from "./studio-discovery.ts";

const DEFAULT_STUDIO_CLI_TIMEOUT = 300_000;

/**
 * Lowest-precedence Studio-executable override (below config key / CLI flag).
 */
const STUDIO_PATH_ENV = "JEST_ROBLOX_STUDIO_PATH";

/**
 * Plugin/CLI protocol version, carried in the Run-mode payload. Matches
 * `STUDIO_PROTOCOL_VERSION` in the WebSocket `studio` backend and
 * `PROTOCOL_VERSION` in the plugin. The bootstrap echoes the version the
 * run-mode runner returns; {@link assertProtocolMatch} rejects a plugin that
 * omits the echo (a stale runner predating the handshake) or returns a
 * different number, surfacing a clean "update the plugin" error.
 */
const STUDIO_CLI_PROTOCOL_VERSION = 5;

type StudioCliPayload = RunPayload & {
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

/**
 * Default backstop for the graceful kill-on-lock-release: how long to wait for
 * Studio to release `<place>.lock` before hard-killing anyway. The lock is
 * normally freed within ~1–9s of closing the result server, so this only fires
 * for a pathologically long-yielding edit-mode `BindToClose` — in which case
 * we fall back to today's instant kill.
 */
const GRACEFUL_SHUTDOWN_CAP_MS = 15_000;

/**
 * How often the real launcher polls `<place>.lock` while waiting for Studio's
 * graceful `ClosePlace` to release it. Short enough to kill within a frame of
 * the release (the win is skipping the ~30s telemetry drain that follows),
 * long enough to be negligible.
 */
const LOCK_POLL_INTERVAL_MS = 50;

/** Splits Studio's log on either line ending — it writes CRLF on Windows. */
const LOG_LINE_SPLIT_PATTERN = /\r?\n/u;

/** Lines of Studio's engine log quoted when a run times out. */
const STUDIO_LOG_TAIL = 15;

/** Per-line cap on the quoted Studio log tail, in characters. */
const STUDIO_LOG_LINE_LIMIT = 300;

const BACKEND_NAME = "studio-cli";
const WORK_DIR = path.join(".jest-roblox", BACKEND_NAME);
const PLACE_FILE = "place.rbxl";
const PLACE_PROJECT_FILE = "place.project.json";
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
	`while not finished and os.clock() - start < ${SOCKET_LINGER_SECONDS.toString()} do`,
	"\ttask.wait(0.05)",
	"end",
];

/**
 * The result frame the bootstrap pushes back over the localhost WebSocket.
 * Same shape the plugin's `init.server.luau` sends the WebSocket `studio`
 * backend (`type: "results"` + `requestId` correlation), so the two result
 * channels stay wire-compatible. `protocolVersion` is optional here — a stale
 * run-mode runner omits it, and {@link assertProtocolMatch} turns that into a
 * clean "update the plugin" error rather than a schema rejection.
 */
const resultMessageSchema = type({
	"gameOutput?": "string",
	"jestOutput": "string",
	"protocolVersion?": "number",
	"requestId": "string",
	"type": "'results'",
});

export interface StudioCliLaunchRequest {
	/** Full Studio CLI argument vector (already absolute paths). */
	args: Array<string>;
	/**
	 * Show the Studio window during the run (`--headed`) instead of the
	 * default hidden window. Maps to `windowsHide: !headed` in {@link
	 * spawnStudio}.
	 */
	headed: boolean;
	/**
	 * Absolute path of the place Studio opens. Used only to clear a stale
	 * `<place>.lock` a previously killed Studio could not remove itself.
	 */
	placeFile: string;
	/** Absolute path to the Studio executable. */
	studioPath: string;
}

/**
 * A launched Studio the host can kill once the result arrives (or on timeout).
 * The injected seam: unit tests return a fake that drives a canned result
 * frame over the mock WebSocket server instead of launching Studio.
 */
export interface StudioCliProcess {
	/**
	 * Terminate Studio immediately (`TerminateProcess`), skipping graceful
	 * shutdown. Used on every hung/error/timeout path.
	 */
	kill: () => void;
	/**
	 * Graceful teardown: wait for Studio to release `<place>.lock` — which
	 * happens only after every edit-mode `BindToClose` handler ran and
	 * `ClosePlace` finished — then terminate it, skipping Studio's ~30s
	 * post-close telemetry drain. Hard-kills anyway after `graceCapMs` (a
	 * long-yielding handler). Returns immediately; the watch runs in the
	 * background, keeping node's event loop alive (the child handle + a poll
	 * timer) until it fires, so the CLI prints results now and the process
	 * exits once teardown completes. The caller closes the result server first,
	 * which is what lets the bootstrap return and `--quitAfterExecution` begin
	 * the graceful close.
	 */
	killOnLockRelease: (graceCapMs: number) => void;
	/** Subscribe to a spawn failure (e.g. a bad `studioPath`). */
	onError: (listener: (error: Error) => void) => void;
}

/** Spawns Studio and returns the handle the host kills. */
export type StudioCliLauncher = (request: StudioCliLaunchRequest) => StudioCliProcess;

export interface StudioCliOptions {
	/** Place Builder seam; defaults to the real {@link defaultBuildPlace}. */
	buildPlace?: ((options: BuildPlaceOptions) => BuildManifestArtifact) | undefined;
	/**
	 * Result-server factory seam; defaults to an ephemeral-port `ws` server.
	 *
	 * This is the run's result channel: a loopback WebSocket the bootstrap
	 * pushes the envelope back over the instant the run finishes (no file, no
	 * polling, no ~100k print cap). The default binds 127.0.0.1 so it is never
	 * exposed to the network, on port 0 so the OS picks a free port and
	 * concurrent CLI processes never collide; that port is baked into the
	 * bootstrap each run writes.
	 */
	createServer?: (() => WebSocketServer) | undefined;
	/**
	 * Studio-executable resolver seam; defaults to {@link discoverStudioPath}.
	 */
	discover?: ((override: string | undefined) => string) | undefined;
	/**
	 * Backstop for the graceful teardown: hard-kill if `<place>.lock` isn't
	 * released within this many ms. Defaults to
	 * {@link GRACEFUL_SHUTDOWN_CAP_MS}.
	 */
	gracefulShutdownTimeout?: number | undefined;
	/**
	 * Show the Studio window during the run (`--headed`). CLI-only — never
	 * read from config. Defaults to false (hidden window).
	 */
	headed?: boolean | undefined;
	/** Process launcher seam; defaults to the real {@link spawnStudio}. */
	launch?: StudioCliLauncher | undefined;
	/** Explicit Studio executable path (override from config / CLI / env). */
	studioPath?: string | undefined;
	/** Run timeout in milliseconds. Defaults to 300000. */
	timeout?: number | undefined;
}

/** The place a run opens, plus where its scratch files are written. */
interface RunPlace {
	/** Whether this is a workspace run — picks the bootstrap payload shape. */
	isWorkspace: boolean;
	/** Absolute path of the place Studio opens. */
	placeFile: string;
	/** `.jest-roblox/studio-cli` scratch directory for this run. */
	workDirectory: string;
}

interface StudioArgsOptions extends RunPayloadRequest, RunPlace {
	port: number;
	requestId: string;
}

type ResultMessage = typeof resultMessageSchema.infer;

/** How long a run may go unanswered, and where to look when it does. */
interface ResultDeadline {
	/** Studio's engine log, quoted back when the run never answers. */
	outputFile: string;
	/** Wall clock in milliseconds before the run is killed. */
	timeout: number;
}

interface StudioCliResultWait {
	child: StudioCliProcess;
	/** Where Studio logs, quoted back when the run never answers. */
	outputFile: string;
	reject: (error: Error) => void;
	requestId: string;
	resolve: (message: ResultMessage) => void;
	server: WebSocketServer;
	timeout: number;
}

export class StudioCliBackend implements Backend {
	private readonly buildPlace: (options: BuildPlaceOptions) => BuildManifestArtifact;
	private readonly createServer: () => WebSocketServer;
	private readonly discover: (override: string | undefined) => string;
	private readonly gracefulShutdownTimeout: number;
	private readonly headed: boolean;
	private readonly launch: StudioCliLauncher;
	private readonly studioPath: string | undefined;
	private readonly timeout: number;

	public readonly kind = "studio-cli" as const;

	constructor(options: StudioCliOptions = {}) {
		this.buildPlace = options.buildPlace ?? defaultBuildPlace;
		this.createServer =
			options.createServer ?? (() => new WebSocketServer({ host: "127.0.0.1", port: 0 }));
		this.discover =
			options.discover ??
			((override) => {
				return discoverStudioPath({ override: override ?? process.env[STUDIO_PATH_ENV] });
			});
		this.gracefulShutdownTimeout = options.gracefulShutdownTimeout ?? GRACEFUL_SHUTDOWN_CAP_MS;
		this.headed = options.headed ?? false;
		this.launch = options.launch ?? spawnStudio;
		this.studioPath = options.studioPath;
		this.timeout = options.timeout ?? DEFAULT_STUDIO_CLI_TIMEOUT;
	}

	public async runTestsAsync({
		jobs,
		parallel,
		progress = NOOP_RUN_PROGRESS,
		vmParallel,
		workStealing,
	}: BackendOptions): Promise<BackendResult> {
		assertSerialJobs({ jobs, parallel, workStealing });
		const place = this.prepareRunPlace(jobs);
		const runRequest = { runBudgetMs: this.timeout, vmParallel };
		const { placeFile } = place;
		const deadline = this.deadlineFor(place.workDirectory);
		const server = this.createServer();
		let child: StudioCliProcess | undefined;
		// Set once the background watch owns teardown (result in hand), so the
		// `finally` knows not to also hard-kill or re-close.
		let wasGracefulTeardownStarted = false;
		try {
			const port = await serverPortAsync(server);
			const requestId = randomUUID();
			const args = buildStudioArgs({ ...place, ...runRequest, jobs, port, requestId });
			const studioPath = this.discover(this.studioPath);
			// Announced here rather than in the executor, which wraps every
			// backend alike: only a backend knows when its own dispatch window
			// starts.
			const done = progress.begin("tests", describeProjectCount(jobs.length));
			const executionStart = Date.now();
			child = this.launch({ args, headed: this.headed, placeFile, studioPath });
			const message = await waitForResultAsync(server, child, requestId, deadline);
			const executionMs = Date.now() - executionStart;

			done();

			startGracefulTeardown(child, server, this.gracefulShutdownTimeout);
			wasGracefulTeardownStarted = true;

			return buildBackendResult(message, jobs, executionMs);
		} finally {
			if (!wasGracefulTeardownStarted) {
				hardTeardown(child, server);
			}
		}
	}

	/**
	 * Build the Clean Place for a normal (non-coverage) run and return its
	 * path. `loadStringEnabled` is forced on so the Run-mode runner's
	 * LoadString gate passes. Coverage runs skip this and open the instrumented
	 * place instead.
	 */
	private buildCleanPlace(
		primary: ProjectJob,
		rootDirectory: string,
		workDirectory: string,
	): string {
		const placeFile = path.join(workDirectory, PLACE_FILE);
		this.buildPlace({
			loadStringEnabled: true,
			packages: [
				{
					name: BACKEND_NAME,
					packageDirectory: rootDirectory,
					rojoProjectPath: path.resolve(findRojoProject(primary.config)),
				},
			],
			placeFile,
			projectFile: path.join(workDirectory, PLACE_PROJECT_FILE),
			wrap: false,
		});

		return placeFile;
	}

	/** Where a run's result lands, and how long Studio has to put it there. */
	private deadlineFor(workDirectory: string): ResultDeadline {
		return { outputFile: studioOutputFile(workDirectory), timeout: this.timeout };
	}

	/**
	 * Resolve the place Studio opens for this run and the scratch directory its
	 * bootstrap/output files live in, creating both as needed.
	 */
	private prepareRunPlace(jobs: Array<ProjectJob>): RunPlace {
		// jobs[0] is the per-run knob source (rootDir, rojoProject, timeout).
		// eslint-disable-next-line ts/no-non-null-assertion -- assertSerialJobs checked length
		const primary = jobs[0]!;

		const rootDirectory = path.resolve(primary.config.rootDir);
		const workDirectory = path.join(rootDirectory, WORK_DIR);
		fs.mkdirSync(workDirectory, { recursive: true });

		// Which place studio-cli drives, by run shape:
		// - workspace: the synthesized mega-place the workspace runner already
		//   built (with the `__pkg_stage` staging the materializer clones from);
		// - coverage: the Coverage-Instrumented Place `prepareCoverage` built and
		//   recorded in `config.placeFile` — a Clean Place here drops the
		//   instrumentation and reports 0% for every file;
		// - normal: a freshly built Clean Place.
		// Only the normal path builds here; the others reuse `config.placeFile`,
		// already built with LoadStringEnabled so the Run-mode gate passes.
		const isWorkspace = isWorkspaceRun(jobs);
		if (isWorkspace) {
			return {
				isWorkspace,
				placeFile: path.resolve(primary.config.placeFile),
				workDirectory,
			};
		}

		if (primary.config.collectCoverage) {
			return { isWorkspace, placeFile: resolvePlaceFilePath(primary.config), workDirectory };
		}

		return {
			isWorkspace,
			placeFile: this.buildCleanPlace(primary, rootDirectory, workDirectory),
			workDirectory,
		};
	}
}

export function createStudioCliBackend(options: StudioCliOptions = {}): StudioCliBackend {
	return new StudioCliBackend(options);
}

/**
 * studio-cli drives one Studio instance serially, so reject a request it
 * structurally cannot serve before anything is built or launched.
 */
function assertSerialJobs({
	jobs,
	parallel,
	workStealing,
}: Pick<BackendOptions, "jobs" | "parallel" | "workStealing">): void {
	if (jobs.length === 0) {
		throw new Error("StudioCliBackend requires at least one job");
	}

	if (workStealing === true) {
		throw new Error("studio-cli backend is serial and does not support work-stealing");
	}

	// The backend is reachable without the CLI and config validators (it is
	// exported), so it states what it can serve rather than which requests to
	// refuse: one session, which `"auto"` also asks for. That rejects a count
	// above 1 and equally the counts those validators would never pass on — 0,
	// a negative, a fraction, NaN.
	if (parallel !== undefined && parallel !== "auto" && parallel !== 1) {
		throw new Error(
			`studio-cli backend is serial (one Studio instance); --parallel ${String(parallel)} ` +
				'is not supported (use 1 or "auto").',
		);
	}
}

/** The rejection for a run Studio never returned a result frame for. */
/** Where Studio is told to write its engine log for a run. */
function studioOutputFile(workDirectory: string): string {
	return path.join(workDirectory, OUTPUT_FILE);
}

function buildStudioCliPayload(request: RunPayloadRequest): StudioCliPayload {
	return {
		protocolVersion: STUDIO_CLI_PROTOCOL_VERSION,
		test: true,
		...buildRunPayload(request),
	};
}

/**
 * Wrap `content` in a Luau long string, escalating the bracket level
 * (`[=[`, `[==[`, …) until the chosen `]=*]` terminator does not occur in the
 * content. Without this, a config string carrying the level-1 terminator
 * `]=]` (e.g. a `testNamePattern`) would close the string early and emit
 * syntactically invalid Luau — a silent no-result run.
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
 * via `ExecuteRunModeAsync`, and assemble the `message` result frame — a
 * plugin that threw or returned nothing yields a `{ success = false }`
 * envelope, so the host surfaces a clean error rather than hanging.
 */
function bootstrapRunLines(
	payload: StudioCliPayload,
	port: number,
	requestId: string,
): Array<string> {
	return [
		'local HttpService = game:GetService("HttpService")',
		'local StudioTestService = game:GetService("StudioTestService")',
		`local payload = HttpService:JSONDecode(${luauLongString(JSON.stringify(payload))})`,
		`local URL = "ws://localhost:${port.toString()}"`,
		`local REQUEST_ID = ${luauLongString(requestId)}`,
		"local ok, result = pcall(function()",
		"\treturn StudioTestService:ExecuteRunModeAsync(payload)",
		"end)",
		"local message",
		"if not ok then",
		'\tmessage = { type = "results", requestId = REQUEST_ID, gameOutput = "[]", jestOutput = HttpService:JSONEncode({ err = tostring(result), success = false }) }',
		'elseif typeof(result) ~= "table" or result.jestOutput == nil then',
		'\tmessage = { type = "results", requestId = REQUEST_ID, gameOutput = "[]", jestOutput = HttpService:JSONEncode({ err = "studio-cli: the jest plugin produced no result. Install or update the jest-roblox Studio plugin.", success = false }) }',
		"else",
		'\tmessage = { type = "results", requestId = REQUEST_ID, protocolVersion = result.protocolVersion, gameOutput = result.gameOutput or "[]", jestOutput = result.jestOutput }',
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
 */
function buildBootstrap(payload: StudioCliPayload, port: number, requestId: string): string {
	return [...bootstrapRunLines(payload, port, requestId), ...BOOTSTRAP_SEND_LINES, ""].join("\n");
}

/**
 * Write the run's bootstrap script into the work directory and return the
 * Studio CLI argument vector that opens the place and runs it.
 */
function buildStudioArgs({
	jobs,
	placeFile,
	port,
	requestId,
	runBudgetMs,
	vmParallel,
	workDirectory,
}: StudioArgsOptions): Array<string> {
	const bootstrapFile = path.join(workDirectory, BOOTSTRAP_FILE);
	const outputFile = studioOutputFile(workDirectory);
	fs.writeFileSync(
		bootstrapFile,
		buildBootstrap(buildStudioCliPayload({ jobs, runBudgetMs, vmParallel }), port, requestId),
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

/**
 * Reject a run-mode result whose echoed `protocolVersion` doesn't match the
 * CLI's. A stale plugin (run-mode runner predating the handshake) omits the
 * echo entirely (`undefined`); a divergent plugin echoes a different number.
 * Either way the user must update the plugin. Mirrors the WebSocket backend's
 * `version_mismatch` path.
 */
function assertProtocolMatch(actual: number | undefined): void {
	if (actual === STUDIO_CLI_PROTOCOL_VERSION) {
		return;
	}

	const reported = actual === undefined ? "no version" : `v${actual.toString()}`;
	throw new Error(
		"studio-cli: jest-roblox Studio plugin protocol version mismatch " +
			`(plugin reported ${reported}, CLI expects v${STUDIO_CLI_PROTOCOL_VERSION.toString()}). ` +
			"Update the jest-roblox Studio plugin to match this CLI version.",
	);
}

/**
 * Decode the run-mode result frame into the backend result. Decode the
 * envelope before the version check: when the bootstrap reached the plugin but
 * got nothing back (ExecuteRunModeAsync threw, or returned no result) it sends
 * a `{success:false, err}` envelope with no protocolVersion, and that error
 * must win over assertProtocolMatch so the real cause surfaces instead of a
 * misleading version mismatch.
 */
function buildBackendResult(
	message: ResultMessage,
	jobs: Array<ProjectJob>,
	executionMs: number,
): BackendResult {
	const { entries, gameOutputScope } = decodeEnvelope(message.jestOutput);
	assertProtocolMatch(message.protocolVersion);
	if (entries.length !== jobs.length) {
		throw new Error(
			`studio-cli backend returned ${entries.length.toString()} entries but request had ${jobs.length.toString()} jobs`,
		);
	}

	const rawResults: Array<RawBackendEntry> = entries.map((entry) => {
		return { entry, fallbackGameOutput: message.gameOutput, gameOutputScope };
	});

	return { rawResults, timing: { executionMs } };
}

/**
 * The port the result server bound. A real `ws` server started on port 0 binds
 * asynchronously, so wait for `listening` and read the assigned port; the test
 * mock reports its port synchronously and is returned without waiting.
 */
async function serverPortAsync(server: WebSocketServer): Promise<number> {
	const address = server.address();
	if (address !== null && typeof address === "object") {
		return address.port;
	}

	await once(server, "listening");
	const bound = server.address();
	if (bound === null || typeof bound === "string") {
		throw new Error("studio-cli: result WebSocket server failed to bind a port.");
	}

	return bound.port;
}

/**
 * The tail of Studio's own engine log, or nothing when it holds nothing worth
 * printing.
 *
 * Studio's stdio is discarded (see {@link spawnStudio}), so `--outputFile` is
 * the only channel that survives a run the result socket never answered. It is
 * not a guarantee: a place Studio cannot open stops behind a modal dialog with
 * only the echoed bootstrap flushed, which is exactly why the timeout names the
 * file as well as quoting it.
 *
 * @param outputFile - Path Studio was told to log to.
 * @returns Trailing log lines, oldest first, or an empty array.
 */
function readStudioLogTail(outputFile: string): Array<string> {
	let contents;
	try {
		contents = fs.readFileSync(outputFile, "utf-8");
	} catch {
		return [];
	}

	return contents
		.split(LOG_LINE_SPLIT_PATTERN)
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.slice(-STUDIO_LOG_TAIL)
		.map((line) => {
			return line.length > STUDIO_LOG_LINE_LIMIT
				? `${line.slice(0, STUDIO_LOG_LINE_LIMIT)}…`
				: line;
		});
}

/**
 * Names a run Studio never answered, and hands over whatever Studio did log.
 *
 * A bare "timed out" is the least useful thing the backend can say: the run
 * could have wedged in a test, failed to open the place, or died behind a
 * dialog, and Studio's engine log is the only place those read differently.
 *
 * @param timeout - The budget the run was given, in milliseconds.
 * @param outputFile - Path Studio was told to log to.
 * @returns The error to reject the run with.
 */
function timedOutError(timeout: number, outputFile: string): Error {
	const lines = [
		`studio-cli: Studio run timed out after ${timeout.toString()}ms and was terminated.`,
		`  Studio log: ${outputFile}`,
	];
	const tail = readStudioLogTail(outputFile);
	if (tail.length > 0) {
		lines.push("  Last lines Studio logged:");
		for (const line of tail) {
			lines.push(`    ${line}`);
		}
	}

	return new Error(lines.join("\n"));
}

/**
 * Forward every `results` frame carrying `requestId` to `onResult`. Frames
 * that aren't valid JSON, aren't a `results` message, or belong to another run
 * are ignored (engine/plugin chatter).
 */
function listenForResultFrame(
	server: WebSocketServer,
	requestId: string,
	onResult: (message: ResultMessage) => void,
): void {
	server.on("connection", (socket: WebSocket) => {
		socket.on("message", (data: buffer.Buffer) => {
			let raw: JSONValue;
			try {
				raw = JSON.parse(data.toString());
			} catch {
				return;
			}

			const message = resultMessageSchema(raw);
			if (message instanceof type.errors || message.requestId !== requestId) {
				return;
			}

			onResult(message);
		});
	});
}

/**
 * Wire the run's settle sources onto one one-shot gate: the timeout, a Studio
 * spawn failure, the correlated `results` frame, and a server error. Whichever
 * fires first wins and the rest become no-ops.
 */
function awaitStudioCliResult({
	child,
	outputFile,
	reject,
	requestId,
	resolve,
	server,
	timeout,
}: StudioCliResultWait): void {
	let isSettled = false;
	const timer = setTimeout(() => {
		bail(timedOutError(timeout, outputFile));
	}, timeout);

	function settle(action: () => void): void {
		if (isSettled) {
			return;
		}

		isSettled = true;
		clearTimeout(timer);
		action();
	}

	function bail(error: Error): void {
		settle(() => {
			reject(error);
		});
	}

	child.onError((error) => {
		bail(new Error(error.message, { cause: error }));
	});

	listenForResultFrame(server, requestId, (message) => {
		settle(() => {
			resolve(message);
		});
	});

	server.on("error", bail);
}

/**
 * Resolve with the run-mode result frame the bootstrap pushes over the socket,
 * or reject on timeout / spawn failure. Only a `results` message for this
 * `requestId` resolves the run, so a stray frame never settles it with the
 * wrong payload.
 */
async function waitForResultAsync(
	server: WebSocketServer,
	child: StudioCliProcess,
	requestId: string,
	deadline: ResultDeadline,
): Promise<ResultMessage> {
	return new Promise<ResultMessage>((resolve, reject) => {
		awaitStudioCliResult({
			child,
			outputFile: deadline.outputFile,
			reject,
			requestId,
			resolve,
			server,
			timeout: deadline.timeout,
		});
	});
}

/**
 * Terminate any live bootstrap socket and close the result server so a
 * lingering connection can't keep node's event loop running past the CLI's
 * exitCode-based shutdown (the same hazard the WebSocket `studio` backend
 * guards against).
 */
function closeServer(server: WebSocketServer): void {
	for (const client of server.clients) {
		client.terminate();
	}

	server.close();
}

/**
 * Wind a run down the hard way: every error path before the graceful teardown
 * began (timeout, spawn failure, server error — a hung run gets no graceful
 * wait). Kills Studio so node's event loop can drain and the CLI exits, then
 * releases the result server. Not called once the graceful watch has started:
 * from then on the watch owns both the kill and the close.
 *
 * @param child - The Studio process, absent when the launch never happened.
 * @param server - The loopback result server for this run.
 */
function hardTeardown(child: StudioCliProcess | undefined, server: WebSocketServer): void {
	child?.kill();
	closeServer(server);
}

/**
 * Wind a run down now that the result is in hand, decoupling teardown from it:
 * close the result server (so the bootstrap returns and `--quitAfterExecution`
 * begins a graceful `ClosePlace` that runs edit-mode `BindToClose` handlers and
 * frees the lock), then kill the instant the lock releases — skipping Studio's
 * ~30s telemetry drain. The watch is non-awaited, so results return now and the
 * process exits after teardown.
 *
 * @param child - The Studio process that answered.
 * @param server - The loopback result server for this run.
 * @param graceCapMs - Backstop before the watch hard-kills anyway.
 */
function startGracefulTeardown(
	child: StudioCliProcess,
	server: WebSocketServer,
	graceCapMs: number,
): void {
	closeServer(server);
	child.killOnLockRelease(graceCapMs);
}

/**
 * Real launcher: clear a stale `<place>.lock` (a previously killed Studio
 * can't remove its own, and a back-to-back run would otherwise open the place
 * onto it and crash), then spawn Studio and return the handle the host kills.
 * The result arrives over the WebSocket, not the process — the host kills this
 * Studio once it lands (instantly, or after a graceful close; see {@link
 * StudioCliProcess}).
 *
 * `stdio: "ignore"` because nothing is read from the pipes — an unconsumed
 * `stdout` pipe could backpressure-stall a chatty Studio.
 */
function spawnStudio(request: StudioCliLaunchRequest): StudioCliProcess {
	const lockFile = `${request.placeFile}.lock`;
	fs.rmSync(lockFile, { force: true });

	// headed mode intentionally shows the Studio window; `!request.headed` is
	// the deliberate lever, not an accidental terminal popup.
	const child = spawn(request.studioPath, request.args, {
		stdio: "ignore",
		windowsHide: !request.headed,
	});

	return {
		kill: () => {
			child.kill();
		},
		killOnLockRelease: (graceCapMs) => {
			// Studio holds `<place>.lock` from open until `ClosePlace` releases
			// it — which happens only after `--quitAfterExecution` ran the
			// edit-mode `BindToClose` handlers. Poll for the release and kill the
			// instant it's gone; the cap is a backstop for a long-yielding
			// handler.
			const deadline = Date.now() + graceCapMs;
			const timer = setInterval(() => {
				const isHeld = fs.existsSync(lockFile) && Date.now() < deadline;
				if (isHeld) {
					return;
				}

				clearInterval(timer);
				child.kill();
			}, LOCK_POLL_INTERVAL_MS);
		},
		onError: (listener) => {
			child.on("error", listener);
		},
	};
}
