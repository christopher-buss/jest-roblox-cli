import type { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import process from "node:process";

import type { FileSystem } from "./file-system.ts";
import { nodeFileSystem } from "./file-system.ts";

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

/** What separates a temp file's target basename from the stamp that owns it. */
const TEMPORARY_INFIX = ".tmp.";

/**
 * How much randomness the stamp's nonce carries. The pid is what the sweep
 * probes; the nonce is what keeps the probe's answer true until the delete
 * lands. An operating system recycles a pid, so a name built from the pid alone
 * is one a later writer can be handed while an abandoned file still holds it —
 * and the sweep, having probed the pid between the two, deletes a write in
 * flight. No two writes draw the same nonce, so the name the sweep resolves
 * belongs to the owner it probed and to nothing else.
 */
const NONCE_BYTES = 4;

/** An owner pid and its write's nonce, and nothing else, close the name. */
const OWNER_STAMP_REGEX = /^(\d+)\.[\da-f]+$/;

export interface AtomicWriteOptions {
	/** The bytes to publish. */
	readonly contents: Buffer | string;
	/** Where the bytes land. Defaults to the real filesystem. */
	readonly fileSystem?: FileSystem;
	/**
	 * Whether to collect this target's abandoned temp files first. On by
	 * default; a publisher that writes a directory's worth of one-shot targets
	 * turns it off, since the scan is per write and the strays it would find
	 * belong to a rebuilt tree. Omitting it costs a directory scan, never a
	 * lost write.
	 */
	readonly sweepStrays?: boolean;
	/** Where the bytes land, once whole. */
	readonly targetPath: string;
}

/**
 * Publish `contents` to `targetPath` atomically: write to a sibling temp file
 * then `renameSync` into place, so a reader never observes a partial write at
 * the target. The temp file lives in the target's own directory to keep the
 * rename on a single filesystem. Parent directories are created as needed.
 *
 * The guarantee is scoped to `targetPath`: a failed write, or a hard kill
 * between the two steps, leaves the temp file behind rather than a partial
 * target. Those strays accumulate, so each publish first sweeps the ones this
 * target has collected, skipping any whose owner is still running.
 *
 * That the owner is named by the temp file itself is what lets the sweep live
 * here rather than at the one caller holding a lock over its target — see
 * `isProcessAlive` and `NONCE_BYTES` for what the two halves of that name
 * settle between them. A caller that does hold a lock gets the sweep inside it
 * at no extra cost.
 *
 * The rename is retried a bounded number of times; the last failure surfaces
 * once the attempts are spent.
 *
 * @param options - Destination, contents, and whether to sweep first.
 */
export function atomicWrite({
	contents,
	fileSystem = nodeFileSystem,
	sweepStrays = true,
	targetPath,
}: AtomicWriteOptions): void {
	const directory = path.dirname(targetPath);
	fileSystem.mkdirSync(directory, { recursive: true });
	const basename = path.basename(targetPath);
	if (sweepStrays) {
		sweepAbandonedTemporaries(fileSystem, directory, basename);
	}

	const stamp = `${process.pid}.${randomBytes(NONCE_BYTES).toString("hex")}`;
	const temporaryPath = path.join(directory, `${basename}${TEMPORARY_INFIX}${stamp}`);
	fileSystem.writeFileSync(temporaryPath, contents);

	let lastError: unknown;
	for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
		if (attempt > 0) {
			pause(RENAME_RETRY_PAUSE_MS);
		}

		try {
			fileSystem.renameSync(temporaryPath, targetPath);
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

/** The one `process.kill` failure that means the pid names nothing. */
function isNoSuchProcessError(err: unknown): boolean {
	return err instanceof Error && "code" in err && err.code === "ESRCH";
}

/**
 * Whether `pid` still names a running process. Signal `0` runs every
 * permission check and delivers nothing, so `ESRCH` is the one answer that
 * means gone — a pid this user may not signal raises `EPERM` and is alive.
 *
 * Erring towards alive is what makes the sweep safe without a lock. A running
 * owner is never swept, and an owner that is gone can never rename the name it
 * left behind, so the only mistake available is keeping a stray a while longer.
 *
 * @param pid - The owner pid read off a temp file's name.
 */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return !isNoSuchProcessError(err);
	}
}

/**
 * Delete the temp files for `basename` whose owner is gone, leaving every live
 * owner's alone.
 *
 * A name that carries no nonce is left alone whatever its pid says. Only a
 * writer from before the nonce existed makes one, and that writer is the one
 * case where a recycled pid can put a live write behind a name this sweep has
 * already judged abandoned.
 *
 * @param fileSystem - Where the temp files live.
 * @param directory - The target's own directory, where its temp files live.
 * @param basename - The target's filename, which its temp files are prefixed
 *   with.
 */
function sweepAbandonedTemporaries(
	fileSystem: FileSystem,
	directory: string,
	basename: string,
): void {
	const prefix = `${basename}${TEMPORARY_INFIX}`;
	let entries: Array<string>;
	try {
		entries = fileSystem.readdirSync(directory);
	} catch {
		// Housekeeping, so a directory the platform will not list costs the
		// sweep rather than the write it precedes.
		return;
	}

	for (const entry of entries) {
		if (!entry.startsWith(prefix)) {
			continue;
		}

		const stamp = OWNER_STAMP_REGEX.exec(entry.slice(prefix.length));
		if (stamp === null || isProcessAlive(Number(stamp[1]))) {
			continue;
		}

		try {
			fileSystem.rmSync(path.join(directory, entry));
		} catch {
			// Per entry, not around the loop: one file a Windows scanner holds
			// open, or one a peer sweeping the same directory took between the
			// listing and here, is left for the next publisher — the strays
			// behind it are still collected.
		}
	}
}
