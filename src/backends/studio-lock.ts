import type { FileSystem } from "../utils/file-system.ts";

const LOCK_POLL_INTERVAL_MS = 50;

/**
 * Remove the `<place>.lock` a killed Studio could not remove itself.
 *
 * @param fileSystem - File system that holds the place.
 * @param placeFile - Path of the place file.
 * @returns The lock file path.
 */
export function clearStaleLock(fileSystem: FileSystem, placeFile: string): string {
	const lockFile = `${placeFile}.lock`;
	fileSystem.rmSync(lockFile, { force: true });
	return lockFile;
}

/**
 * Poll until the lock file is gone or the grace cap passes, then terminate.
 *
 * @param options - Lock file, file system, grace cap, and terminate callback.
 */
export function watchLockRelease({
	fileSystem,
	graceCapMs,
	lockFile,
	terminate,
}: {
	/** File system that holds the lock file. */
	readonly fileSystem: FileSystem;
	/** Milliseconds to wait before terminating anyway. */
	readonly graceCapMs: number;
	/** Path of the place lock file. */
	readonly lockFile: string;
	/** Called once, when the lock releases or the cap passes. */
	readonly terminate: () => void;
}): void {
	const deadline = Date.now() + graceCapMs;
	const timer = setInterval(() => {
		const isHeld = fileSystem.existsSync(lockFile) && Date.now() < deadline;
		if (isHeld) {
			return;
		}

		clearInterval(timer);
		terminate();
	}, LOCK_POLL_INTERVAL_MS);
}
