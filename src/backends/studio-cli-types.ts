import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";

/** A launched Studio the host kills once the result arrives or on timeout. */
export interface StudioCliProcess {
	/** Terminate Studio now, skipping graceful shutdown. */
	kill: () => void;
	/**
	 * Terminate Studio once it releases `<place>.lock`, or after `graceCapMs`.
	 * The caller must close the result server first.
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
	/** Show the Studio window during the run. */
	headed: boolean;
	/** Launch Studio hidden from the user. */
	hiddenDesktop: boolean;
	/** Absolute path of the place Studio opens. */
	placeFile: string;
	/** Host OS, which picks the hidden launch method. */
	platform: NodeJS.Platform;
	/** Absolute path to the Studio executable. */
	studioPath: string;
}

/** Spawns Studio and returns the handle the host kills. */
export type StudioCliLauncher = (request: StudioCliLaunchRequest) => StudioCliProcess;
