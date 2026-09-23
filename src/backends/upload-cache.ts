import { type } from "arktype";
import { createHash } from "node:crypto";
import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

/**
 * Records which place version a set of place-file bytes already has on Roblox,
 * so an unchanged build can skip `places.save` entirely.
 *
 * An entry also means those bytes boot: the caller writes it only once its boot
 * probe has come back, so a hit is what lets a later run skip the probe too.
 *
 * Why it is worth skipping: an upload is the only thing measured to precede a
 * cold place boot. Across 60 tasks, every upload-free task ran warm (~3s) while
 * tasks following an upload ran cold (~22s) in most windows. The mechanism is
 * undocumented and the rate varies, so treat the fast path as a bonus over a
 * correct-but-slow path, never as something to depend on. See
 * `docs/research/open-cloud-warm-boot/README.md`.
 *
 * The cache cannot be validated against the server — Open Cloud exposes no
 * content hash for a place version. It does not need to be: the caller submits
 * every task to the recorded version itself, which holds exactly the bytes this
 * file hashed, and a version keeps existing after head moves on. A version Open
 * Cloud no longer serves answers with a 404, and the caller drops the entry.
 */
export interface UploadCacheTarget {
	/** Absolute path of the place file whose bytes were uploaded. */
	placeFilePath: string;
	placeId: number | string;
	universeId: number | string;
}

/**
 * What a cached upload records: the inputs it was built from, and its version.
 */
export interface CacheEntry {
	hash: string;
	versionNumber: number;
}

interface CacheFile {
	entries: Record<string, CacheEntry>;
	version: number;
}

/**
 * Bumped when an entry's meaning changes, which discards every file written
 * under the old one. Version 2 added the claim that the bytes boot — only a
 * boot probe can make it, and a version-1 file never did.
 */
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
 * Undefined when the place file cannot be read. The caller then uploads, which
 * fails on the same file with the API's own message — a cache miss must never
 * be the thing that reports a missing place.
 */
export function hashPlaceFile(
	placeFilePath: string,
	fileSystem: FileSystem = nodeFileSystem,
): string | undefined {
	try {
		return createHash("sha256").update(fileSystem.readFileSync(placeFilePath)).digest("hex");
	} catch {
		return undefined;
	}
}

/**
 * The version already holding `hash` for this target, or undefined when these
 * bytes have never been uploaded from this machine.
 */
export function readCachedVersion(
	rootDirectory: string,
	target: UploadCacheTarget,
	hash: string,
	fileSystem: FileSystem = nodeFileSystem,
): number | undefined {
	const entry = readCacheFile(fileSystem, rootDirectory).entries[entryKey(target)];
	return entry?.hash === hash ? entry.versionNumber : undefined;
}

export function writeCachedVersion(
	rootDirectory: string,
	target: UploadCacheTarget,
	{ hash, versionNumber }: CacheEntry,
	fileSystem: FileSystem = nodeFileSystem,
): void {
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
 * True once the entry is gone. A cache file that cannot be written keeps
 * serving the entry it already holds, so the caller hears no.
 */
export function invalidateCachedVersion(
	rootDirectory: string,
	target: UploadCacheTarget,
	fileSystem: FileSystem = nodeFileSystem,
): boolean {
	const cache = readCacheFile(fileSystem, rootDirectory);
	const key = entryKey(target);
	// `deleteProperty` reports success for an absent key too, so ask first —
	// otherwise a no-op invalidate rewrites the file for nothing.
	if (!Object.hasOwn(cache.entries, key)) {
		return true;
	}

	Reflect.deleteProperty(cache.entries, key);
	try {
		fileSystem.writeFileSync(cachePath(rootDirectory), JSON.stringify(cache, undefined, "\t"));
	} catch {
		// As above — best effort, and the caller says only what it can stand
		// behind: an entry that survives the write is still the one in use.
		return false;
	}

	return true;
}

/**
 * One entry per (universe, place, place file) rather than per content hash, so
 * the file stays bounded — re-uploading a changed build overwrites its entry
 * instead of appending another.
 */
function entryKey({ placeFilePath, placeId, universeId }: UploadCacheTarget): string {
	return `${String(universeId)}/${String(placeId)}/${normalizeWindowsPath(placeFilePath)}`;
}

/**
 * Deliberately not under `.jest-roblox/coverage/` — a non-incremental coverage
 * rebuild wipes that directory, which would drop the cache on exactly the runs
 * that rebuilt an identical place.
 */
function cachePath(rootDirectory: string): string {
	return path.join(rootDirectory, ".jest-roblox", "upload-cache.json");
}

/**
 * Every failure mode — missing file, unreadable file, malformed JSON, an
 * unknown `version`, a junk entry — collapses to "no cache". That is how the
 * format migrates without a migration, and why a corrupt file costs a re-upload
 * rather than a run.
 */
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
		// See above — an unreadable cache is simply an empty one.
	}

	return { entries, version: CACHE_VERSION };
}
