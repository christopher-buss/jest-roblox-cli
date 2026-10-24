import type { FileSystem } from "../utils/file-system.ts";

const LOCK_POLL_INTERVAL_MS = 50;

/**
 * Remove the `<place>.lock` a killed Studio could not remove itself, so a
 * back-to-back run does not open the place onto it and crash.
 */
export function clearStaleLock(fileSystem: FileSystem, placeFile: string): string {
	const lockFile = `${placeFile}.lock`;
	fileSystem.rmSync(lockFile, { force: true });
	return lockFile;
}

export function watchLockRelease({
	fileSystem,
	graceCapMs,
	lockFile,
	terminate,
}: {
	readonly fileSystem: FileSystem;
	readonly graceCapMs: number;
	readonly lockFile: string;
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
