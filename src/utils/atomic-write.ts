import type { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

/**
 * Windows fails a rename with `EPERM`/`EBUSY` when a scanner or indexer holds
 * the file open for the moment after it is written. The window is short, so a
 * couple of retries clears it.
 */
const RENAME_ATTEMPTS = 5;

/**
 * The hold lasts long enough that a tight loop can spend every attempt inside
 * one window. A pause of this length was measured to clear it on the first
 * retry.
 */
const RENAME_RETRY_PAUSE_MS = 2;

/**
 * Publish `contents` to `targetPath` atomically: write to a sibling temp file
 * then `renameSync` into place, so a reader never observes a partial write at
 * the target. The temp file lives in the target's own directory to keep the
 * rename on a single filesystem. Parent directories are created as needed.
 *
 * The guarantee is scoped to `targetPath`: a failed write leaves the temp file
 * behind rather than a partial target — temp cleanup is not attempted.
 *
 * The rename is retried a bounded number of times; the last failure surfaces
 * once the attempts are spent.
 */
export function atomicWrite(targetPath: string, contents: Buffer | string): void {
	const directory = path.dirname(targetPath);
	fs.mkdirSync(directory, { recursive: true });
	const temporaryPath = path.join(directory, `${path.basename(targetPath)}.tmp.${process.pid}`);
	fs.writeFileSync(temporaryPath, contents);

	let lastError: unknown;
	for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
		if (attempt > 0) {
			pause(RENAME_RETRY_PAUSE_MS);
		}

		try {
			fs.renameSync(temporaryPath, targetPath);
			return;
		} catch (err) {
			lastError = err;
		}
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * `atomicWrite` is synchronous for the six publishers that call it from a
 * non-async path, so the pause cannot be a timer: `Atomics.wait` on a
 * never-signalled buffer is the only synchronous sleep node offers.
 *
 * @param milliseconds - How long to block before the next rename attempt.
 */
function pause(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
