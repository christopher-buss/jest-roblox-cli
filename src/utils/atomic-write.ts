import type { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import process from "node:process";

import type { FileSystem } from "./file-system.ts";
import { nodeFileSystem } from "./file-system.ts";

// Windows fails a rename with EPERM/EBUSY while a scanner holds the new file.
const RENAME_ATTEMPTS = 5;

const RENAME_RETRY_PAUSE_MS = 2;

const TEMPORARY_INFIX = ".tmp.";

// The nonce stops a recycled pid from making a live write look abandoned.
const NONCE_BYTES = 4;

// Must match the stamp built in `atomicWrite`.
const OWNER_STAMP_REGEX = /^(\d+)\.[\da-f]+$/;

/** Inputs for one atomic file write. */
export interface AtomicWriteOptions {
	/** The bytes to publish. */
	readonly contents: Buffer | string;
	/** Where the bytes land. Defaults to the real filesystem. */
	readonly fileSystem?: FileSystem;
	/** Whether to delete this target's abandoned temp files first. */
	readonly sweepStrays?: boolean;
	/** Where the bytes land, once whole. */
	readonly targetPath: string;
}

/**
 * Publish `contents` to `targetPath` through a sibling temp file and a rename.
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
		sweepAbandonedTemporaries({ basename, directory, fileSystem });
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

function pause(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isNoSuchProcessError(err: unknown): boolean {
	return err instanceof Error && "code" in err && err.code === "ESRCH";
}

/**
 * The lock-free sweep is safe only while this errs towards alive.
 *
 * @param pid - The owner pid read off a temp file's name.
 * @returns False only when the pid names no process.
 */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return !isNoSuchProcessError(err);
	}
}

function sweepAbandonedTemporaries({
	basename,
	directory,
	fileSystem,
}: {
	readonly basename: string;
	readonly directory: string;
	readonly fileSystem: FileSystem;
}): void {
	const prefix = `${basename}${TEMPORARY_INFIX}`;
	let entries: Array<string>;
	try {
		entries = fileSystem.readdirSync(directory);
	} catch {
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
			// Per entry, so one locked file does not stop the sweep.
		}
	}
}
