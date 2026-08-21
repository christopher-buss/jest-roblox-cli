import { type } from "arktype";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

/**
 * Records which place version a set of place-file bytes already has on Roblox,
 * so an unchanged build can skip `places.save` entirely.
 *
 * Why it is worth skipping: an upload is the only thing measured to precede a
 * cold place boot. Across 60 tasks, every upload-free task ran warm (~3s) while
 * tasks following an upload ran cold (~22s) in most windows. The mechanism is
 * undocumented and the rate varies, so treat the fast path as a bonus over a
 * correct-but-slow path, never as something to depend on. See
 * `docs/research/open-cloud-warm-boot/README.md`.
 *
 * The cache cannot be validated against the server — Open Cloud exposes no
 * content hash for a place version, nor a way to ask which version is head. It
 * does not need to be: the caller runs tasks behind the `game.PlaceVersion`
 * guard, so a stale entry can only make the guard fire and the task retry
 * pinned to the recorded version, which holds exactly the bytes this file
 * hashed. The guard names the version it booted, so the caller invalidates an
 * entry it proves is behind head — a cache hit never uploads, so an entry left
 * in place could never become head again on its own.
 */
export interface UploadCacheTarget {
	/** Absolute path of the place file whose bytes were uploaded. */
	placeFilePath: string;
	placeId: number | string;
	universeId: number | string;
}

interface CacheEntry {
	hash: string;
	versionNumber: number;
}

interface CacheFile {
	entries: Record<string, CacheEntry>;
	version: number;
}

const CACHE_VERSION = 1;

const cacheEntrySchema = type({
	"+": "delete",
	"hash": "string",
	"versionNumber": "number",
}).as<CacheEntry>();

const cacheFileInputSchema = type({
	entries: type({ "[string]": "unknown" }),
	version: "1",
});

/**
 * Undefined when the place file cannot be read. The caller then uploads, which
 * fails on the same file with the API's own message — a cache miss must never
 * be the thing that reports a missing place.
 */
export function hashPlaceFile(placeFilePath: string): string | undefined {
	try {
		return createHash("sha256").update(fs.readFileSync(placeFilePath)).digest("hex");
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
): number | undefined {
	const entry = readCacheFile(rootDirectory).entries[entryKey(target)];
	return entry?.hash === hash ? entry.versionNumber : undefined;
}

export function writeCachedVersion(
	rootDirectory: string,
	target: UploadCacheTarget,
	hash: string,
	versionNumber: number,
): void {
	const cache = readCacheFile(rootDirectory);
	cache.entries[entryKey(target)] = { hash, versionNumber };
	try {
		fs.mkdirSync(path.dirname(cachePath(rootDirectory)), { recursive: true });
		fs.writeFileSync(cachePath(rootDirectory), JSON.stringify(cache, undefined, "\t"));
	} catch {
		// A cache that cannot be written costs speed, never correctness.
	}
}

/**
 * True once the entry is gone. A cache file that cannot be written keeps
 * serving the entry it already holds, so the caller hears no.
 */
export function invalidateCachedVersion(rootDirectory: string, target: UploadCacheTarget): boolean {
	const cache = readCacheFile(rootDirectory);
	const key = entryKey(target);
	// `deleteProperty` reports success for an absent key too, so ask first —
	// otherwise a no-op invalidate rewrites the file for nothing.
	if (!Object.hasOwn(cache.entries, key)) {
		return true;
	}

	Reflect.deleteProperty(cache.entries, key);
	try {
		fs.writeFileSync(cachePath(rootDirectory), JSON.stringify(cache, undefined, "\t"));
	} catch {
		// As above — best effort, and the caller says only what it can stand
		// behind: an entry that survives the write is still the one in use.
		return false;
	}

	return true;
}

/**
 * Whether a task booting `bootedVersion` proves `reusedVersion` is behind
 * head.
 */
export function isBehindHead({
	bootedVersion,
	reusedVersion,
}: {
	bootedVersion: number;
	reusedVersion: number;
}): boolean {
	return bootedVersion > reusedVersion;
}

/**
 * Drop the entry when a task proves it is behind head, and report whether it
 * went. This is the only evidence there is — Open Cloud will not say which
 * version is head, so a task that booted past the reused one is what stands in
 * for asking. Dropping it keeps the slow path from becoming permanent: a cache
 * hit never uploads, so an entry left in place can never become head again on
 * its own, and every later run pays a pinned cold boot. Dropping one that was
 * in fact fine costs a single upload on the next run.
 */
export function invalidateIfBehindHead(
	rootDirectory: string,
	target: UploadCacheTarget,
	versions: { bootedVersion: number; reusedVersion: number },
): boolean {
	return isBehindHead(versions) && invalidateCachedVersion(rootDirectory, target);
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
function readCacheFile(rootDirectory: string): CacheFile {
	const entries: Record<string, CacheEntry> = {};
	try {
		const parsed = cacheFileInputSchema(
			JSON.parse(fs.readFileSync(cachePath(rootDirectory), "utf8")),
		);
		if (parsed instanceof type.errors) {
			return { entries, version: CACHE_VERSION };
		}

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
