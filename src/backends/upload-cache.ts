import { type } from "arktype";
import { createHash } from "node:crypto";
import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { WORK_DIRECTORY } from "../utils/work-directory.ts";

/** The place file and the place its upload-cache entry belongs to. */
export interface UploadCacheTarget {
	/** Absolute path of the place file whose bytes were uploaded. */
	placeFilePath: string;
	/** Place the upload targets. */
	placeId: number | string;
	/** Universe that owns the place. */
	universeId: number | string;
}

/** What a cached upload records. */
export interface CacheEntry {
	/** SHA-256 hash of the uploaded place file. */
	hash: string;
	/** Place version that holds the uploaded bytes. */
	versionNumber: number;
}

interface CacheFile {
	entries: Record<string, CacheEntry>;
	version: number;
}

// Bump with `version` in `cacheFileInputSchema` when an entry's meaning changes.
const CACHE_VERSION = 2;

const cacheEntrySchema = type({
	"+": "delete",
	"hash": "string",
	"versionNumber": "number",
}).as<CacheEntry>();

const cacheFileInputSchema = type({
	entries: type({ "[string]": "unknown" }),
	version: "2",
});

/**
 * Fingerprint a built place so an unchanged one skips upload.
 * @param placeFilePath - Path of the place file to hash.
 * @param fileSystem - File system to read from.
 * @returns The hex SHA-256 hash, or `undefined` when the file cannot be read.
 */
export function hashPlaceFile(placeFilePath: string, fileSystem: FileSystem): string | undefined {
	try {
		return createHash("sha256").update(fileSystem.readFileSync(placeFilePath)).digest("hex");
	} catch {
		return undefined;
	}
}

/**
 * The version already holding `hash` for this target.
 * @param root0 - Lookup input.
 * @param root0.fileSystem - File system to read from.
 * @param root0.hash - Hash of the place file.
 * @param root0.rootDirectory - Project root that holds the cache file.
 * @param root0.target - Upload target.
 * @returns The cached version number, or `undefined` on a miss.
 */
export function readCachedVersion({
	fileSystem,
	hash,
	rootDirectory,
	target,
}: {
	/** File system to read from. */
	readonly fileSystem: FileSystem;
	/** Hash of the place file. */
	readonly hash: string;
	/** Project root that holds the cache file. */
	readonly rootDirectory: string;
	/** Upload target. */
	readonly target: UploadCacheTarget;
}): number | undefined {
	const entry = readCacheFile(fileSystem, rootDirectory).entries[entryKey(target)];
	return entry?.hash === hash ? entry.versionNumber : undefined;
}

/**
 * Records an uploaded version for a target; a failed write is ignored.
 * @param root0 - Write input.
 * @param root0.entry - Hash and version to record.
 * @param root0.fileSystem - File system to write to.
 * @param root0.rootDirectory - Project root that holds the cache file.
 * @param root0.target - Upload target.
 */
export function writeCachedVersion({
	entry: { hash, versionNumber },
	fileSystem,
	rootDirectory,
	target,
}: {
	/** Hash and version to record. */
	readonly entry: CacheEntry;
	/** File system to write to. */
	readonly fileSystem: FileSystem;
	/** Project root that holds the cache file. */
	readonly rootDirectory: string;
	/** Upload target. */
	readonly target: UploadCacheTarget;
}): void {
	const cache = readCacheFile(fileSystem, rootDirectory);
	cache.entries[entryKey(target)] = { hash, versionNumber };
	try {
		fileSystem.mkdirSync(path.dirname(cachePath(rootDirectory)), { recursive: true });
		fileSystem.writeFileSync(cachePath(rootDirectory), JSON.stringify(cache, undefined, "\t"));
	} catch {
		// A cache that cannot be written costs speed, never correctness.
	}
}

/**
 * Remove the cache entry of a target.
 * @param root0 - Invalidate input.
 * @param root0.fileSystem - File system to write to.
 * @param root0.rootDirectory - Project root that holds the cache file.
 * @param root0.target - Upload target.
 * @returns Whether the entry is gone.
 */
export function invalidateCachedVersion({
	fileSystem,
	rootDirectory,
	target,
}: {
	readonly fileSystem: FileSystem;
	readonly rootDirectory: string;
	readonly target: UploadCacheTarget;
}): boolean {
	const cache = readCacheFile(fileSystem, rootDirectory);
	const key = entryKey(target);
	if (!Object.hasOwn(cache.entries, key)) {
		return true;
	}

	Reflect.deleteProperty(cache.entries, key);
	try {
		fileSystem.writeFileSync(cachePath(rootDirectory), JSON.stringify(cache, undefined, "\t"));
	} catch {
		return false;
	}

	return true;
}

function entryKey({ placeFilePath, placeId, universeId }: UploadCacheTarget): string {
	return `${String(universeId)}/${String(placeId)}/${normalizeWindowsPath(placeFilePath)}`;
}

/**
 * Not under `.jest-roblox/coverage/`: a coverage rebuild wipes that folder.
 *
 * @param rootDirectory - Project root that holds the cache file.
 * @returns The path of the cache file.
 */
function cachePath(rootDirectory: string): string {
	return path.join(rootDirectory, WORK_DIRECTORY, "upload-cache.json");
}

function readCacheFile(fileSystem: FileSystem, rootDirectory: string): CacheFile {
	const entries: Record<string, CacheEntry> = {};
	try {
		const parsed = cacheFileInputSchema.assert(
			JSON.parse(fileSystem.readFileSync(cachePath(rootDirectory), "utf8")),
		);

		for (const [key, value] of Object.entries(parsed.entries)) {
			const entry = cacheEntrySchema(value);
			if (!(entry instanceof type.errors)) {
				entries[key] = entry;
			}
		}
	} catch {
		// An unreadable cache is an empty one.
	}

	return { entries, version: CACHE_VERSION };
}
