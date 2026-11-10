import { randomUUID } from "node:crypto";
import * as path from "node:path";
import process from "node:process";
import type { Except } from "type-fest";
import type { WebSocketServer } from "ws";

import { resolvePlaceFilePath } from "../config/resolved-config.ts";
import type { RunProgress } from "../progress/run-progress.ts";
import { NOOP_RUN_PROGRESS } from "../progress/run-progress.ts";
import { describeProjectCount } from "../progress/stages.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { WORK_DIRECTORY } from "../utils/work-directory.ts";
import type { BackendOf, BackendResult, RunSettings } from "./interface.ts";
import type { RunPayloadRequest, StudioDispatch } from "./plugin-payload.ts";
import type { ManagedPluginInstall, RunnerPluginInstallOptions } from "./runner-plugin.ts";
import { installRunnerPluginAsync } from "./runner-plugin.ts";
import { buildStudioArgs, type RunPlace, studioOutputFile } from "./studio-cli-bootstrap.ts";
import {
	BOOT_TIMEOUT_ENV,
	DEFAULT_BOOT_WATCH_MS,
	type ResultDeadline,
} from "./studio-cli-deadlines.ts";
import {
	hardTeardown,
	launchStudioProcess,
	resolveHiddenDesktop,
	startGracefulTeardown,
} from "./studio-cli-process.ts";
import {
	buildBackendResult,
	serverPortAsync,
	waitForResultAsync,
} from "./studio-cli-result-wait.ts";
import type { StudioCliLauncher, StudioCliProcess } from "./studio-cli-types.ts";
import { configuredStudioPath, discoverStudioPath } from "./studio-discovery.ts";
import { nodeWebSocketServerFactory } from "./web-socket-server-factory.ts";
import type { WebSocketServerFactory } from "./web-socket-server-factory.ts";

const GRACEFUL_SHUTDOWN_CAP_MS = 15_000;
const WORK_DIR = path.join(WORK_DIRECTORY, "studio-cli");

/** Options for {@link StudioCliBackend}. */
export interface StudioCliOptions {
	/** Milliseconds Studio may take from launch to starting the run. */
	bootTimeout?: number | undefined;
	/** What launches Studio. */
	childProcess: ChildProcessRunner;
	/** Resolves the Studio executable. */
	discover?: ((override: string | undefined) => string) | undefined;
	/** Where the run stages its files. */
	fileSystem: FileSystem;
	/** Milliseconds to wait for `<place>.lock` release before a hard kill. */
	gracefulShutdownTimeout?: number | undefined;
	/** Show the Studio window during the run. */
	headed?: boolean | undefined;
	/** Launch Studio hidden. */
	hiddenDesktop?: boolean | undefined;
	/** Installs the Managed Plugin, given the run's scratch directory. */
	installPluginAsync?:
		| ((workDirectory: string) => Promise<ManagedPluginInstall | undefined>)
		| undefined;
	/** Launches the Studio process. */
	launch?: StudioCliLauncher | undefined;
	/** Host platform. */
	platform?: NodeJS.Platform | undefined;
	/** Studio plugins folder the Managed Plugin installs into. */
	pluginsDirectory?: string | undefined;
	/** Explicit Studio executable path. */
	studioPath?: string | undefined;
	/** Opens the result server. */
	webSocketServerFactory?: undefined | WebSocketServerFactory;
}

interface StudioCliDispatch {
	deadline: ResultDeadline;
	jobs: StudioDispatch["jobs"];
	place: RunPlace;
	plugin: ManagedPluginInstall | undefined;
	progress: RunProgress;
	runRequest: Except<RunPayloadRequest, "jobs" | "runtimeStubs">;
	server: WebSocketServer;
	studioPath: string;
}

interface StudioCliSession {
	child?: StudioCliProcess | undefined;
	wasGracefulTeardownStarted: boolean;
}

/** Builds a place, launches a local Studio on it, and waits for the result. */
export class StudioCliBackend implements BackendOf<"studio-cli", StudioDispatch> {
	private readonly bootTimeout: number;
	private readonly childProcess: ChildProcessRunner;
	private readonly discover: (override: string | undefined) => string;
	private readonly fileSystem: FileSystem;
	private readonly gracefulShutdownTimeout: number;
	private readonly headed: boolean;
	private readonly hiddenDesktop: boolean;
	private readonly installPluginAsync: (
		workDirectory: string,
	) => Promise<ManagedPluginInstall | undefined>;
	private readonly launch: StudioCliLauncher;
	private readonly platform: NodeJS.Platform;
	private readonly studioPath: string | undefined;
	private readonly webSocketServerFactory: WebSocketServerFactory;

	public readonly kind = "studio-cli" as const;

	/**
	 * Resolves every option against its default.
	 * @param options - Seams, timeouts and Studio location; omitted ones use defaults.
	 * @throws {Error} When {@link BOOT_TIMEOUT_ENV} is not a positive integer.
	 */
	constructor(options: StudioCliOptions) {
		this.bootTimeout = options.bootTimeout ?? resolveBootTimeout();
		const { fileSystem } = options;
		this.discover =
			options.discover ??
			((override) => {
				return discoverStudioPath({
					fileSystem,
					override: configuredStudioPath(override),
				});
			});
		this.childProcess = options.childProcess;
		this.fileSystem = fileSystem;
		this.gracefulShutdownTimeout = options.gracefulShutdownTimeout ?? GRACEFUL_SHUTDOWN_CAP_MS;
		this.headed = options.headed ?? false;
		this.platform = options.platform ?? process.platform;
		this.hiddenDesktop = resolveHiddenDesktop({ ...options, platform: this.platform });
		this.installPluginAsync =
			options.installPluginAsync ??
			installPluginInto({
				childProcess: this.childProcess,
				fileSystem,
				pluginsDirectory: options.pluginsDirectory,
			});
		this.launch = options.launch ?? launchStudioProcess;
		this.studioPath = options.studioPath;
		this.webSocketServerFactory = options.webSocketServerFactory ?? nodeWebSocketServerFactory;
	}

	/**
	 * Installs the plugin, launches Studio, and waits for its result.
	 * @param request - Jobs and run options, run in one Studio session.
	 * @returns The per-job results and execution timing.
	 * @rejects {Error} When Studio is not found or the run fails.
	 */
	public async runTestsAsync({
		bail,
		jobs,
		progress = NOOP_RUN_PROGRESS,
		runSettings,
		vmParallel,
		workspace,
	}: StudioDispatch): Promise<BackendResult> {
		const place = this.prepareRunPlace(runSettings);
		const studioPath = this.discover(this.studioPath);
		const plugin = await this.installPluginAsync(place.workDirectory);
		const server = this.webSocketServerFactory({ host: "127.0.0.1", port: 0 });
		const session: StudioCliSession = { wasGracefulTeardownStarted: false };
		try {
			return await this.dispatchRunAsync(session, {
				deadline: this.deadlineFor(place.workDirectory, runSettings.timeout),
				jobs,
				place,
				plugin,
				progress,
				runRequest: { bail, runBudgetMs: runSettings.timeout, vmParallel, workspace },
				server,
				studioPath,
			});
		} finally {
			if (!session.wasGracefulTeardownStarted) {
				hardTeardown(session.child, server);
			}
		}
	}

	private deadlineFor(workDirectory: string, timeout: number): ResultDeadline {
		return {
			bootTimeout: this.bootTimeout,
			outputFile: studioOutputFile(workDirectory),
			timeout,
		};
	}

	private async dispatchRunAsync(
		session: StudioCliSession,
		{
			deadline,
			jobs,
			place,
			plugin,
			progress,
			runRequest,
			server,
			studioPath,
		}: StudioCliDispatch,
	): Promise<BackendResult> {
		const requestId = randomUUID();
		const args = buildStudioArgs({
			...place,
			...runRequest,
			fileSystem: this.fileSystem,
			jobs,
			pluginKey: plugin?.key,
			port: await serverPortAsync(server),
			requestId,
		});
		const done = progress.begin("tests", describeProjectCount(jobs.length));
		const executionStart = Date.now();
		const child = this.launchStudio({ args, placeFile: place.placeFile, studioPath });
		session.child = child;
		const channel = { child, fileSystem: this.fileSystem, pluginKey: plugin?.key, server };
		const message = await waitForResultAsync({ ...channel, deadline, requestId });

		done();
		startGracefulTeardown({ child, graceCapMs: this.gracefulShutdownTimeout, server });
		session.wasGracefulTeardownStarted = true;

		return buildBackendResult(message, {
			executionMs: Date.now() - executionStart,
			jobs,
			manualPlugins: plugin?.manualPlugins ?? [],
		});
	}

	private launchStudio({
		args,
		placeFile,
		studioPath,
	}: {
		readonly args: Array<string>;
		readonly placeFile: string;
		readonly studioPath: string;
	}): StudioCliProcess {
		return this.launch({
			args,
			childProcess: this.childProcess,
			fileSystem: this.fileSystem,
			headed: this.headed,
			hiddenDesktop: this.hiddenDesktop,
			placeFile,
			platform: this.platform,
			studioPath,
		});
	}

	private prepareRunPlace(runSettings: RunSettings): RunPlace {
		const workDirectory = path.join(path.resolve(runSettings.rootDir), WORK_DIR);
		this.fileSystem.mkdirSync(workDirectory, { recursive: true });
		return { placeFile: resolvePlaceFilePath(runSettings), workDirectory };
	}
}

function resolveBootTimeout(): number {
	const raw = process.env[BOOT_TIMEOUT_ENV];
	if (raw === undefined || raw === "") {
		return DEFAULT_BOOT_WATCH_MS;
	}

	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(
			`${BOOT_TIMEOUT_ENV} must be a positive integer of milliseconds, got "${raw}".`,
		);
	}

	return parsed;
}

function installPluginInto(
	install: Except<RunnerPluginInstallOptions, "workDirectory">,
): (workDirectory: string) => Promise<ManagedPluginInstall | undefined> {
	return async (workDirectory) => installRunnerPluginAsync({ ...install, workDirectory });
}
