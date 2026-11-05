import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";

/**
 * A launched Studio the host can kill once the result arrives (or on timeout).
 * The injected seam: unit tests return a fake that drives a canned result
 * frame over the mock WebSocket server instead of launching Studio.
 */
export interface StudioCliProcess {
	/**
	 * Terminate Studio now, skipping graceful shutdown: SIGTERM, then SIGKILL
	 * if it is still alive after a short grace. Used on every
	 * hung/error/timeout path.
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
	/** Subscribe to a spawn failure, such as a bad `studioPath`. */
	onError: (listener: (error: Error) => void) => void;
}

/** What a Studio CLI launch needs. */
export interface StudioCliLaunchRequest {
	/** Full Studio CLI argument vector (already absolute paths). */
	args: Array<string>;
	/** What launches Studio. Defaults to the real launcher. */
	childProcess: ChildProcessRunner;
	/** Where the lock file is watched. Defaults to the real filesystem. */
	fileSystem: FileSystem;
	/**
	 * Show the Studio window during the run (`--headed`) instead of the
	 * default hidden window. Maps to `windowsHide: !headed` in
	 * `spawnStudio`.
	 */
	headed: boolean;
	/** Launch Studio hidden from the user. */
	hiddenDesktop: boolean;
	/**
	 * Absolute path of the place Studio opens. Used only to clear a stale
	 * `<place>.lock` a previously killed Studio could not remove itself.
	 */
	placeFile: string;
	/** Host OS, which picks the hidden launch method. */
	platform: NodeJS.Platform;
	/** Absolute path to the Studio executable. */
	studioPath: string;
}

/** Spawns Studio and returns the handle the host kills. */
export type StudioCliLauncher = (request: StudioCliLaunchRequest) => StudioCliProcess;
