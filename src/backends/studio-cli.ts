import { randomUUID } from "node:crypto";
import process from "node:process";
import type { Except } from "type-fest";
import type { WebSocketServer } from "ws";

import type { BuildManifestArtifact } from "../coverage-pipeline/build-manifest.ts";
import type { RunProgress } from "../progress/reporter.ts";
import { NOOP_RUN_PROGRESS } from "../progress/reporter.ts";
import { describeProjectCount } from "../progress/stages.ts";
import {
	type BuildPlaceOptions,
	buildPlaceAsync as defaultBuildPlace,
} from "../staging/place-builder.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { nodeChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { DEFAULT_BOOT_WATCH_MS } from "./execution-recovery.ts";
import type { Backend, BackendOptions, BackendResult, ProjectJob } from "./interface.ts";
import type { RunPayloadRequest } from "./plugin-payload.ts";
import type { ManagedPluginInstall, RunnerPluginInstallOptions } from "./runner-plugin.ts";
import { installRunnerPluginAsync } from "./runner-plugin.ts";
import { buildStudioArgs, type RunPlace, studioOutputFile } from "./studio-cli-bootstrap.ts";
import { BOOT_TIMEOUT_ENV, type ResultDeadline } from "./studio-cli-deadlines.ts";
import { prepareRunPlaceAsync } from "./studio-cli-place.ts";
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

const DEFAULT_STUDIO_CLI_TIMEOUT = 300_000;

/**
 * Lowest-precedence Studio-executable override (below config key / CLI flag).
 */

/**
 * Default backstop for the graceful kill-on-lock-release: how long to wait for
 * Studio to release `<place>.lock` before hard-killing anyway. The lock is
 * normally freed within ~1–9s of closing the result server, so this only fires
 * for a pathologically long-yielding edit-mode `BindToClose` — in which case
 * we fall back to today's instant kill.
 */
const GRACEFUL_SHUTDOWN_CAP_MS = 15_000;

/**
 * Options for {@link StudioCliBackend}; every seam defaults to the real
 * implementation.
 */
export interface StudioCliOptions {
	/**
	 * How long Studio may take from launch to starting the run, in
	 * milliseconds. Defaults to {@link BOOT_TIMEOUT_ENV}, else
	 * {@link DEFAULT_BOOT_WATCH_MS}.
	 */
	bootTimeout?: number | undefined;
	/** Place Builder seam; defaults to the real {@link defaultBuildPlace}. */
	buildPlaceAsync?: ((options: BuildPlaceOptions) => Promise<BuildManifestArtifact>) | undefined;
	/** What launches Studio. Defaults to the real launcher. */
	childProcess?: ChildProcessRunner;
	/**
	 * Studio-executable resolver seam; defaults to {@link discoverStudioPath}.
	 */
	discover?: ((override: string | undefined) => string) | undefined;
	/** Where the run stages its files. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
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
	/**
	 * Launch Studio on a hidden desktop; resolved against `platform` and
	 * `headed`.
	 */
	hiddenDesktop?: boolean | undefined;
	/**
	 * Puts the Managed Plugin in the Studio plugins folder before launch, given
	 * the run's scratch directory. Resolves undefined where none was installed.
	 */
	installPluginAsync?:
		| ((workDirectory: string) => Promise<ManagedPluginInstall | undefined>)
		| undefined;
	/**
	 * Process launcher seam; defaults to the real {@link launchStudioProcess}.
	 */
	launch?: StudioCliLauncher | undefined;
	/** Host platform. Defaults to `process.platform`. */
	platform?: NodeJS.Platform | undefined;
	/** Studio plugins folder the Managed Plugin installs into. */
	pluginsDirectory?: string | undefined;
	/** Explicit Studio executable path (override from config / CLI / env). */
	studioPath?: string | undefined;
	/** Run timeout in milliseconds. Defaults to 300000. */
	timeout?: number | undefined;
	/** Result server seam; defaults to the real WebSocket server. */
	webSocketServerFactory?: undefined | WebSocketServerFactory;
}

/**
 * What one dispatch launches and waits on: the place it opens, the jobs it
 * runs, and the socket the result comes back over.
 */
interface StudioCliDispatch {
	deadline: ResultDeadline;
	jobs: Array<ProjectJob>;
	place: RunPlace;
	plugin: ManagedPluginInstall | undefined;
	progress: RunProgress;
	runRequest: Except<RunPayloadRequest, "jobs">;
	server: WebSocketServer;
	/** The Studio executable the run launches. */
	studioPath: string;
}

/**
 * The child a run launched and who owns tearing it down. Mutable because the
 * caller's `finally` reads what the dispatch had reached when it threw.
 */
interface StudioCliSession {
	child?: StudioCliProcess | undefined;
	/**
	 * Set once the background watch owns teardown (result in hand), so the
	 * `finally` knows not to also hard-kill or re-close.
	 */
	wasGracefulTeardownStarted: boolean;
}

/**
 * Backend that builds a place, launches a local Studio on it, and waits for
 * the result.
 */
export class StudioCliBackend implements Backend {
	private readonly bootTimeout: number;
	private readonly buildPlaceAsync: (
		options: BuildPlaceOptions,
	) => Promise<BuildManifestArtifact>;
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
	private readonly timeout: number;
	private readonly webSocketServerFactory: WebSocketServerFactory;

	public readonly kind = "studio-cli" as const;
	public readonly placeInput = "own" as const;

	/**
	 * Resolves every option against its default.
	 * @param options - Seams, timeouts and Studio location; omitted ones use defaults.
	 * @throws {Error} When {@link BOOT_TIMEOUT_ENV} is not a positive integer.
	 */
	constructor(options: StudioCliOptions = {}) {
		this.bootTimeout = options.bootTimeout ?? resolveBootTimeout();
		this.buildPlaceAsync = options.buildPlaceAsync ?? defaultBuildPlace;
		const fileSystem = options.fileSystem ?? nodeFileSystem;
		this.discover =
			options.discover ??
			((override) => {
				return discoverStudioPath({
					fileSystem,
					override: configuredStudioPath(override),
				});
			});
		this.childProcess = options.childProcess ?? nodeChildProcessRunner;
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
		this.timeout = options.timeout ?? DEFAULT_STUDIO_CLI_TIMEOUT;
		this.webSocketServerFactory = options.webSocketServerFactory ?? nodeWebSocketServerFactory;
	}

	/**
	 * Builds the place, installs the plugin, launches Studio, and waits for its result.
	 * @param root0 - Jobs and run options.
	 * @param root0.bail - Stop after this many failures.
	 * @param root0.jobs - Jobs to run, in one Studio session.
	 * @param root0.progress - Receives stage progress.
	 * @param root0.vmParallel - VM parallelism to request.
	 * @param root0.workStealing - Must not be `true`; this backend runs jobs serially.
	 * @returns The per-job results and execution timing.
	 * @rejects {Error} When there are no jobs, work-stealing is set, Studio is not found, or the run fails.
	 */
	public async runTestsAsync({
		bail,
		jobs,
		progress = NOOP_RUN_PROGRESS,
		vmParallel,
		workStealing,
	}: BackendOptions): Promise<BackendResult> {
		assertSerialJobs({ jobs, workStealing });
		const place = await prepareRunPlaceAsync({
			buildPlaceAsync: this.buildPlaceAsync,
			fileSystem: this.fileSystem,
			jobs,
		});
		// Found before the plugin is installed: without Studio there is no run
		// to install it for.
		const studioPath = this.discover(this.studioPath);
		const plugin = await this.installPluginAsync(place.workDirectory);
		const server = this.webSocketServerFactory({ host: "127.0.0.1", port: 0 });
		const session: StudioCliSession = { wasGracefulTeardownStarted: false };
		try {
			return await this.dispatchRunAsync(session, {
				deadline: this.deadlineFor(place.workDirectory),
				jobs,
				place,
				plugin,
				progress,
				runRequest: { bail, runBudgetMs: this.timeout, vmParallel },
				server,
				studioPath,
			});
		} finally {
			if (!session.wasGracefulTeardownStarted) {
				hardTeardown(session.child, server);
			}
		}
	}

	/**
	 * Where a run's result lands, and how long Studio has to put it there.
	 * @param workDirectory - Scratch directory of the run.
	 * @returns The result deadline.
	 */
	private deadlineFor(workDirectory: string): ResultDeadline {
		return {
			bootTimeout: this.bootTimeout,
			outputFile: studioOutputFile(workDirectory),
			timeout: this.timeout,
		};
	}

	/**
	 * Launch Studio against the prepared place and wait for its result frame.
	 *
	 * Records the child and the teardown decision on `session` as it goes, so
	 * the caller's `finally` can clean up after a throw from any point here.
	 * @param session - Mutable record of the launched child and teardown state.
	 * @param root0 - What the dispatch launches and waits on.
	 * @returns The per-job results and execution timing.
	 */
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
		// Announced here rather than in the executor, which wraps every backend
		// alike: only a backend knows when its own dispatch window starts.
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

	/**
	 * The Studio the run was pointed at, launched against the place it built.
	 * @param root0 - Launch input.
	 * @param root0.args - Studio command-line arguments.
	 * @param root0.placeFile - Place file to open.
	 * @param root0.studioPath - Studio executable.
	 * @returns The launched Studio process.
	 */
	private launchStudio({
		args,
		placeFile,
		studioPath,
	}: {
		/** Studio command-line arguments. */
		readonly args: Array<string>;
		/** Place file to open. */
		readonly placeFile: string;
		/** Studio executable. */
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
}

/**
 * Creates a Studio CLI backend.
 * @param options - Seams, timeouts and Studio location; omitted ones use defaults.
 * @returns The new backend.
 */
export function createStudioCliBackend(options: StudioCliOptions = {}): StudioCliBackend {
	return new StudioCliBackend(options);
}

/**
 * The boot window {@link BOOT_TIMEOUT_ENV} asks for, else the default. Throws
 * on a value that is not a positive integer.
 * @returns The boot window in milliseconds.
 * @throws {Error} When the variable is set but is not a positive integer.
 */
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

/**
 * Binds the install options so only the scratch directory is left.
 * @param install - Plugin install options without the work directory.
 * @returns An installer that takes the run's scratch directory.
 */
function installPluginInto(
	install: Except<RunnerPluginInstallOptions, "workDirectory">,
): (workDirectory: string) => Promise<ManagedPluginInstall | undefined> {
	return async (workDirectory) => installRunnerPluginAsync({ ...install, workDirectory });
}

/**
 * The studio-cli backend drives one Studio instance serially, so reject a request it
 * structurally cannot serve before anything is built or launched. A
 * `parallel` count is not such a request: the run is one session whatever
 * it asks for.
 * @param root0 - Jobs and work-stealing flag.
 * @throws {Error} When there are no jobs or work-stealing is requested.
 */
function assertSerialJobs({
	jobs,
	workStealing,
}: Pick<BackendOptions, "jobs" | "workStealing">): void {
	if (jobs.length === 0) {
		throw new Error("StudioCliBackend requires at least one job");
	}

	if (workStealing === true) {
		throw new Error("studio-cli backend is serial and does not support work-stealing");
	}
}
