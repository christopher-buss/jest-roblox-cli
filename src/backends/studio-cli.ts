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
import {
	type BuildPlaceOptions,
	buildPlace as defaultBuildPlace,
} from "../staging/place-builder.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { parseEnvelope } from "./envelope.ts";
import {
	type Backend,
	type BackendOptions,
	type BackendResult,
	isWorkspaceRun,
	type ProjectJob,
	type RawBackendEntry,
} from "./interface.ts";
import { buildConfigEntries, buildWorkspaceEntries } from "./plugin-payload.ts";
import { discoverStudioPath } from "./studio-discovery.ts";

const DEFAULT_STUDIO_CLI_TIMEOUT = 300_000;

/** Lowest-precedence Studio-executable override (below config key / CLI flag). */
const STUDIO_PATH_ENV = "JEST_ROBLOX_STUDIO_PATH";

/**
 * Plugin/CLI protocol version, carried in the Run-mode payload. Matches
 * `STUDIO_PROTOCOL_VERSION` in the WebSocket `studio` backend and
 * `PROTOCOL_VERSION` in the plugin. The bootstrap echoes the version the
 * run-mode runner returns; {@link assertProtocolMatch} rejects a plugin that
 * omits the echo (a stale runner predating the handshake) or returns a
 * different number, surfacing a clean "update the plugin" error.
 */
const STUDIO_CLI_PROTOCOL_VERSION = 3;

/**
 * Seconds the bootstrap keeps its result socket alive after sending, waiting to
 * be closed/killed by the host. A backstop only: the host kills Studio the
 * instant it receives the result, so the bootstrap is normally terminated
 * mid-wait. Long enough to never truncate a send, short enough that a host that
 * vanished doesn't wedge Studio open.
 */
const SOCKET_LINGER_SECONDS = 30;

/**
 * Default backstop for the graceful kill-on-lock-release: how long to wait for
 * Studio to release `<place>.lock` before hard-killing anyway. The lock is
 * normally freed within ~1–9s of closing the result server, so this only fires
 * for a pathologically long-yielding edit-mode `BindToClose` — in which case we
 * fall back to today's instant kill.
 */
const GRACEFUL_SHUTDOWN_CAP_MS = 15_000;

/**
 * How often the real launcher polls `<place>.lock` while waiting for Studio's
 * graceful `ClosePlace` to release it. Short enough to kill within a frame of
 * the release (the win is skipping the ~30s telemetry drain that follows), long
 * enough to be negligible.
 */
const LOCK_POLL_INTERVAL_MS = 50;

const BACKEND_NAME = "studio-cli";
const WORK_DIR = path.join(".jest-roblox", BACKEND_NAME);
const PLACE_FILE = "place.rbxl";
const PLACE_PROJECT_FILE = "place.project.json";
const BOOTSTRAP_FILE = "bootstrap.server.luau";
const OUTPUT_FILE = "output.log";

/**
 * The result frame the bootstrap pushes back over the localhost WebSocket. Same
 * shape the plugin's `init.server.luau` sends the WebSocket `studio` backend
 * (`type: "results"` + `request_id` correlation), so the two result channels
 * stay wire-compatible. `protocolVersion` is optional here — a stale run-mode
 * runner omits it, and {@link assertProtocolMatch} turns that into a clean
 * "update the plugin" error rather than a schema rejection.
 */
const resultMessageSchema = type({
	"gameOutput?": "string",
	"jestOutput": "string",
	"protocolVersion?": "number",
	"request_id": "string",
	"type": "'results'",
});

export interface StudioCliLaunchRequest {
	/** Full Studio CLI argument vector (already absolute paths). */
	args: Array<string>;
	/**
	 * Show the Studio window during the run (`--headed`) instead of the default
	 * hidden window. Maps to `windowsHide: !headed` in {@link spawnStudio}.
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
 * The injected seam: unit tests return a fake that drives a canned result frame
 * over the mock WebSocket server instead of launching Studio.
 */
export interface StudioCliProcess {
	/**
	 * Terminate Studio immediately (`TerminateProcess`), skipping graceful
	 * shutdown. Used on every hung/error/timeout path.
	 */
	kill: () => void;
	/**
	 * Graceful teardown: wait for Studio to release
	 * `<place>.lock` — which happens only after every edit-mode `BindToClose`
	 * handler ran and `ClosePlace` finished — then terminate it, skipping
	 * Studio's ~30s post-close telemetry drain. Hard-kills anyway after
	 * `graceCapMs` (a long-yielding handler). Returns immediately; the watch runs
	 * in the background, keeping node's event loop alive (the child handle + a
	 * poll timer) until it fires, so the CLI prints results now and the process
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
	buildPlace?: (options: BuildPlaceOptions) => BuildManifestArtifact;
	/** Result-server factory seam; defaults to an ephemeral-port `ws` server. */
	createServer?: () => WebSocketServer;
	/** Studio-executable resolver seam; defaults to {@link discoverStudioPath}. */
	discover?: (override: string | undefined) => string;
	/**
	 * Backstop for the graceful teardown: hard-kill if `<place>.lock` isn't
	 * released within this many ms. Defaults to {@link GRACEFUL_SHUTDOWN_CAP_MS}.
	 */
	gracefulShutdownTimeout?: number;
	/**
	 * Show the Studio window during the run (`--headed`). CLI-only — never read
	 * from config. Defaults to false (hidden window).
	 */
	headed?: boolean;
	/** Process launcher seam; defaults to the real {@link spawnStudio}. */
	launch?: StudioCliLauncher;
	/** Explicit Studio executable path (override from config / CLI / env). */
	studioPath?: string;
	/** Run timeout in milliseconds. Defaults to 300000. */
	timeout?: number;
}

type ResultMessage = typeof resultMessageSchema.infer;

export class StudioCliBackend implements Backend {
	private readonly buildPlace: (options: BuildPlaceOptions) => BuildManifestArtifact;
	private readonly createServer: () => WebSocketServer;
	private readonly discover: (override: string | undefined) => string;
	private readonly gracefulShutdownTimeout: number;
	private readonly headed: boolean;
	private readonly launch: StudioCliLauncher;
	private readonly studioPath?: string;
	private readonly timeout: number;

	public readonly kind = "studio-cli" as const;

	constructor(options: StudioCliOptions = {}) {
		this.buildPlace = options.buildPlace ?? defaultBuildPlace;
		this.createServer =
			options.createServer ?? (() => new WebSocketServer({ host: "127.0.0.1", port: 0 }));
		this.discover =
			options.discover ??
			((override) =>
				discoverStudioPath({ override: override ?? process.env[STUDIO_PATH_ENV] }));
		this.gracefulShutdownTimeout = options.gracefulShutdownTimeout ?? GRACEFUL_SHUTDOWN_CAP_MS;
		this.headed = options.headed ?? false;
		this.launch = options.launch ?? spawnStudio;
		this.studioPath = options.studioPath;
		this.timeout = options.timeout ?? DEFAULT_STUDIO_CLI_TIMEOUT;
	}

	public async runTests(options: BackendOptions): Promise<BackendResult> {
		const { jobs, parallel, workStealing } = options;
		if (jobs.length === 0) {
			throw new Error("StudioCliBackend requires at least one job");
		}

		if (workStealing === true) {
			throw new Error("studio-cli backend is serial and does not support work-stealing");
		}

		if (parallel !== undefined && parallel !== 1) {
			throw new Error(
				"studio-cli backend is serial (one Studio instance); --parallel > 1 is not supported.",
			);
		}

		// jobs[0] is the per-run knob source (rootDir, rojoProject, timeout).
		// eslint-disable-next-line ts/no-non-null-assertion -- length checked above
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
		const workspace = isWorkspaceRun(jobs);
		let placeFile: string;
		if (workspace) {
			placeFile = path.resolve(primary.config.placeFile);
		} else if (primary.config.collectCoverage) {
			placeFile = resolvePlaceFilePath(primary.config);
		} else {
			placeFile = this.buildCleanPlace(primary, rootDirectory, workDirectory);
		}

		// Result channel: a loopback WebSocket server the bootstrap pushes the
		// envelope back over the instant the run finishes (no file, no polling,
		// no ~100k print cap). Bound to 127.0.0.1 so it's never exposed to the
		// network, on port 0 so the OS picks a free port (concurrent CLI
		// processes never collide); the port is baked into the bootstrap below.
		const server = this.createServer();
		let child: StudioCliProcess | undefined;
		// Set once the graceful teardown has been handed off to the background
		// watch (result in hand), so the `finally` knows not to also hard-kill or
		// re-close — the watch owns both from then on.
		let gracefulTeardownStarted = false;
		try {
			const port = await serverPort(server);
			const requestId = randomUUID();

			const bootstrapFile = path.join(workDirectory, BOOTSTRAP_FILE);
			const outputFile = path.join(workDirectory, OUTPUT_FILE);
			fs.writeFileSync(
				bootstrapFile,
				buildBootstrap(
					workspace ? buildWorkspacePayload(jobs) : buildConfigsPayload(jobs),
					port,
					requestId,
				),
			);

			const studioPath = this.discover(this.studioPath);
			const args = [
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

			const executionStart = Date.now();
			child = this.launch({ args, headed: this.headed, placeFile, studioPath });
			const message = await waitForResult(server, child, requestId, this.timeout);
			const executionMs = Date.now() - executionStart;

			// The result is in hand. Decouple teardown from it: close the result
			// server (so the bootstrap returns and `--quitAfterExecution` begins
			// a graceful `ClosePlace` that runs edit-mode `BindToClose` handlers
			// and frees the lock), then kill the instant the lock releases —
			// skipping Studio's ~30s telemetry drain. The watch is non-awaited,
			// so results return now and the process exits after teardown.
			closeServer(server);
			child.killOnLockRelease(this.gracefulShutdownTimeout);
			gracefulTeardownStarted = true;

			// parseEnvelope before the version check: when the bootstrap reached
			// the plugin but got nothing back (ExecuteRunModeAsync threw, or
			// returned no result) it sends a `{success:false, err}` envelope with
			// no protocolVersion, and that error must win over
			// assertProtocolMatch so the real cause surfaces instead of a
			// misleading version mismatch.
			const entries = parseEnvelope(message.jestOutput);
			assertProtocolMatch(message.protocolVersion);
			if (entries.length !== jobs.length) {
				throw new Error(
					`studio-cli backend returned ${entries.length.toString()} entries but request had ${jobs.length.toString()} jobs`,
				);
			}

			const rawResults: Array<RawBackendEntry> = entries.map((entry) => {
				return { entry, fallbackGameOutput: message.gameOutput };
			});

			return { rawResults, timing: { executionMs } };
		} finally {
			// Every error path before the graceful teardown began (timeout,
			// spawn failure, server error — a hung run gets no graceful wait):
			// hard-kill Studio so node's event loop can drain and the CLI exits,
			// then release the result server. When the graceful watch already
			// started (result in hand), it owns the kill and the close — don't
			// re-kill or re-close.
			if (!gracefulTeardownStarted) {
				child?.kill();
				closeServer(server);
			}
		}
	}

	/**
	 * Build the Clean Place for a normal (non-coverage) run and return its path.
	 * `loadStringEnabled` is forced on so the Run-mode runner's LoadString gate
	 * passes. Coverage runs skip this and open the instrumented place instead.
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
}

export function createStudioCliBackend(options: StudioCliOptions = {}): StudioCliBackend {
	return new StudioCliBackend(options);
}

/**
 * Single-/multi-project payload: the run-mode runner reads `config.configs` and
 * drives `Runner.runProjects`.
 */
function buildConfigsPayload(jobs: Array<ProjectJob>): object {
	const { configs, runtimeStubMounts } = buildConfigEntries(jobs);
	return {
		config: { configs },
		protocolVersion: STUDIO_CLI_PROTOCOL_VERSION,
		runtimeStubMounts,
		test: true,
	};
}

/**
 * Workspace payload: the run-mode runner sees the `workspace` shape and drives
 * the staged materializer (`runEmbedded`) — cloning each package from the
 * mega-place's `__pkg_stage`, running, resetting.
 */
function buildWorkspacePayload(jobs: Array<ProjectJob>): object {
	return {
		protocolVersion: STUDIO_CLI_PROTOCOL_VERSION,
		test: true,
		workspace: { entries: buildWorkspaceEntries(jobs) },
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
 * The `--runScriptFile` script. Runs at command-bar level in the edit DataModel,
 * drives the installed plugin's Run-mode runner via `ExecuteRunModeAsync`, then
 * pushes the result envelope back to the host over a localhost WebSocket
 * (`HttpService:CreateWebStreamClient`, the same client API the plugin uses).
 * `request_id` correlates the frame with this run. A plugin that is absent or
 * returns nothing sends a `{ success = false }` envelope, so the host surfaces a
 * clean error rather than hanging.
 */
function buildBootstrap(payload: object, port: number, requestId: string): string {
	return [
		'local HttpService = game:GetService("HttpService")',
		'local StudioTestService = game:GetService("StudioTestService")',
		`local payload = HttpService:JSONDecode(${luauLongString(String(JSON.stringify(payload)))})`,
		`local URL = "ws://localhost:${port.toString()}"`,
		`local REQUEST_ID = ${luauLongString(requestId)}`,
		"local ok, result = pcall(function()",
		"\treturn StudioTestService:ExecuteRunModeAsync(payload)",
		"end)",
		"local message",
		"if not ok then",
		'\tmessage = { type = "results", request_id = REQUEST_ID, gameOutput = "[]", jestOutput = HttpService:JSONEncode({ err = tostring(result), success = false }) }',
		'elseif typeof(result) ~= "table" or result.jestOutput == nil then',
		'\tmessage = { type = "results", request_id = REQUEST_ID, gameOutput = "[]", jestOutput = HttpService:JSONEncode({ err = "studio-cli: the jest plugin produced no result. Install or update the jest-roblox Studio plugin.", success = false }) }',
		"else",
		'\tmessage = { type = "results", request_id = REQUEST_ID, protocolVersion = result.protocolVersion, gameOutput = result.gameOutput or "[]", jestOutput = result.jestOutput }',
		"end",
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
		// Keep the script (and socket) alive until the host receives the frame
		// and kills us, or the linger backstop elapses. See
		// SOCKET_LINGER_SECONDS.
		"local start = os.clock()",
		`while not finished and os.clock() - start < ${SOCKET_LINGER_SECONDS.toString()} do`,
		"\ttask.wait(0.05)",
		"end",
		"",
	].join("\n");
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
 * The port the result server bound. A real `ws` server started on port 0 binds
 * asynchronously, so wait for `listening` and read the assigned port; the test
 * mock reports its port synchronously and is returned without waiting.
 */
async function serverPort(server: WebSocketServer): Promise<number> {
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
 * Resolve with the run-mode result frame the bootstrap pushes over the socket,
 * or reject on timeout / spawn failure. Frames that aren't a `results` message
 * for this `requestId` are ignored (engine/plugin chatter), so a stray frame
 * never resolves the run with the wrong payload.
 */
async function waitForResult(
	server: WebSocketServer,
	child: StudioCliProcess,
	requestId: string,
	timeout: number,
): Promise<ResultMessage> {
	return new Promise<ResultMessage>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			settle(() => {
				reject(
					new Error(
						`studio-cli: Studio run timed out after ${timeout.toString()}ms and was terminated.`,
					),
				);
			});
		}, timeout);

		function settle(action: () => void): void {
			if (settled) {
				return;
			}

			settled = true;
			clearTimeout(timer);
			action();
		}

		child.onError((error) => {
			settle(() => {
				reject(new Error(error.message, { cause: error }));
			});
		});

		server.on("connection", (socket: WebSocket) => {
			socket.on("message", (data: buffer.Buffer) => {
				let raw: unknown;
				try {
					raw = JSON.parse(data.toString());
				} catch {
					return;
				}

				const message = resultMessageSchema(raw);
				if (message instanceof type.errors || message.request_id !== requestId) {
					return;
				}

				settle(() => {
					resolve(message);
				});
			});
		});

		server.on("error", (error: Error) => {
			settle(() => {
				reject(error);
			});
		});
	});
}

/**
 * Terminate any live bootstrap socket and close the result server so a lingering
 * connection can't keep node's event loop running past the CLI's exitCode-based
 * shutdown (the same hazard the WebSocket `studio` backend guards against).
 */
function closeServer(server: WebSocketServer): void {
	for (const client of server.clients) {
		client.terminate();
	}

	server.close();
}

/**
 * Real launcher: clear a stale `<place>.lock` (a previously killed Studio can't
 * remove its own, and a back-to-back run would otherwise open the place onto it
 * and crash), then spawn Studio and return the handle the host kills. The result
 * arrives over the WebSocket, not the process — the host kills this Studio once
 * it lands (instantly, or after a graceful close; see {@link StudioCliProcess}).
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
				const held = fs.existsSync(lockFile) && Date.now() < deadline;
				if (held) {
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
