import { describe, expect, it, vi } from "vitest";

import type { MemoryVolume } from "../../test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { FileSystem } from "../utils/file-system.ts";
import {
	hashPlaceFile,
	invalidateCachedVersion,
	invalidateIfBehindHead,
	readCachedVersion,
	type UploadCacheTarget,
	writeCachedVersion,
} from "./upload-cache.ts";

const ROOT = "/repo";
const CACHE_PATH = "/repo/.jest-roblox/upload-cache.json";

const TARGET: UploadCacheTarget = {
	placeFilePath: "/repo/game.rbxl",
	placeId: "222",
	universeId: "111",
};

/**
 * Seed the place file on `volume` and report the hash the cache keys on.
 *
 * @param volume - Where the place file lands.
 * @param fileSystem - The same volume, as the code under test reads it.
 * @param contents - The place bytes.
 */
function seedPlaceFile(
	volume: MemoryVolume,
	fileSystem: FileSystem,
	contents = "place-bytes",
): string {
	volume.fromJSON({ "/repo/game.rbxl": contents });
	return hashPlaceFile(TARGET.placeFilePath, fileSystem)!;
}

describe(hashPlaceFile, () => {
	it("should return undefined when the place file cannot be read", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(hashPlaceFile("/repo/missing.rbxl", fileSystem)).toBeUndefined();
	});

	it("should return a different hash when the bytes change", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const first = seedPlaceFile(volume, fileSystem, "one");
		const second = seedPlaceFile(volume, fileSystem, "two");

		expect(first).not.toBe(second);
	});
});

describe("upload cache", () => {
	it("should return undefined when nothing was ever cached", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile(volume, fileSystem);

		expect(readCachedVersion(ROOT, TARGET, hash, fileSystem)).toBeUndefined();
	});

	it("should return the recorded version for the same bytes", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile(volume, fileSystem);

		writeCachedVersion(ROOT, TARGET, { hash, versionNumber: 42 }, fileSystem);

		expect(readCachedVersion(ROOT, TARGET, hash, fileSystem)).toBe(42);
		expect(volume.readFileSync(CACHE_PATH, "utf8")).toBe(
			JSON.stringify(
				{
					entries: {
						"111/222//repo/game.rbxl": { hash, versionNumber: 42 },
					},
					version: 2,
				},
				undefined,
				"\t",
			),
		);
	});

	it("should miss when the bytes changed", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile(volume, fileSystem, "one");
		writeCachedVersion(ROOT, TARGET, { hash, versionNumber: 42 }, fileSystem);

		expect(
			readCachedVersion(ROOT, TARGET, seedPlaceFile(volume, fileSystem, "two"), fileSystem),
		).toBeUndefined();
	});

	it("should miss when the same bytes target a different place", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile(volume, fileSystem);
		writeCachedVersion(ROOT, TARGET, { hash, versionNumber: 42 }, fileSystem);

		expect(
			readCachedVersion(ROOT, { ...TARGET, placeId: "999" }, hash, fileSystem),
		).toBeUndefined();
		expect(
			readCachedVersion(ROOT, { ...TARGET, universeId: "999" }, hash, fileSystem),
		).toBeUndefined();
	});

	it("should replace the entry for a place file rather than adding one", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const stale = seedPlaceFile(volume, fileSystem, "one");
		writeCachedVersion(ROOT, TARGET, { hash: stale, versionNumber: 42 }, fileSystem);
		writeCachedVersion(
			ROOT,
			TARGET,
			{ hash: seedPlaceFile(volume, fileSystem, "two"), versionNumber: 43 },
			fileSystem,
		);

		// The superseded hash must not still resolve — otherwise the file grows
		// without bound and old bytes keep a version alive.
		expect(readCachedVersion(ROOT, TARGET, stale, fileSystem)).toBeUndefined();
		expect(
			readCachedVersion(ROOT, TARGET, seedPlaceFile(volume, fileSystem, "two"), fileSystem),
		).toBe(43);
	});

	it("should keep entries for different place files side by side", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile(volume, fileSystem);
		const other: UploadCacheTarget = { ...TARGET, placeFilePath: "/repo/other.rbxl" };
		writeCachedVersion(ROOT, TARGET, { hash, versionNumber: 42 }, fileSystem);
		writeCachedVersion(ROOT, other, { hash, versionNumber: 43 }, fileSystem);

		expect(readCachedVersion(ROOT, TARGET, hash, fileSystem)).toBe(42);
		expect(readCachedVersion(ROOT, other, hash, fileSystem)).toBe(43);
	});

	it("should drop the entry on invalidate", () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile(volume, fileSystem);

		writeCachedVersion(ROOT, TARGET, { hash, versionNumber: 42 }, fileSystem);

		expect(invalidateCachedVersion(ROOT, TARGET, fileSystem)).toBeTrue();
		expect(readCachedVersion(ROOT, TARGET, hash, fileSystem)).toBeUndefined();
		expect(volume.readFileSync(CACHE_PATH, "utf8")).toBe(
			JSON.stringify({ entries: {}, version: 2 }, undefined, "\t"),
		);
	});

	/**
	 * The one rule that decides whether a reused version is still valid. Open
	 * Cloud will not say which version is head, so a task that booted past the
	 * reused one is the whole of the evidence.
	 */
	it("should drop the entry when a task booted past the reused version", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile(volume, fileSystem);
		writeCachedVersion(ROOT, TARGET, { hash, versionNumber: 42 }, fileSystem);

		expect(
			invalidateIfBehindHead(
				ROOT,
				TARGET,
				{ bootedVersion: 43, reusedVersion: 42 },
				fileSystem,
			),
		).toBeTrue();
		expect(readCachedVersion(ROOT, TARGET, hash, fileSystem)).toBeUndefined();
	});

	it("should keep the entry when a task booted the reused version or older", () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile(volume, fileSystem);
		writeCachedVersion(ROOT, TARGET, { hash, versionNumber: 42 }, fileSystem);

		expect(
			invalidateIfBehindHead(
				ROOT,
				TARGET,
				{ bootedVersion: 41, reusedVersion: 42 },
				fileSystem,
			),
		).toBeFalse();
		expect(
			invalidateIfBehindHead(
				ROOT,
				TARGET,
				{ bootedVersion: 42, reusedVersion: 42 },
				fileSystem,
			),
		).toBeFalse();
		expect(readCachedVersion(ROOT, TARGET, hash, fileSystem)).toBe(42);
	});

	/**
	 * A write that fails leaves the entry in the file, so it is still the one
	 * the next run reads. The caller says so out loud rather than promising a
	 * re-upload that will not happen.
	 */
	it("should report a stale entry as surviving when the cache cannot be written", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile(volume, fileSystem);
		writeCachedVersion(ROOT, TARGET, { hash, versionNumber: 42 }, fileSystem);
		vi.spyOn(fileSystem, "writeFileSync").mockImplementation(() => {
			throw new Error("EROFS: read-only file system");
		});

		expect(
			invalidateIfBehindHead(
				ROOT,
				TARGET,
				{ bootedVersion: 43, reusedVersion: 42 },
				fileSystem,
			),
		).toBeFalse();
		expect(readCachedVersion(ROOT, TARGET, hash, fileSystem)).toBe(42);
	});

	it("should tolerate invalidating when no cache file exists", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedPlaceFile(volume, fileSystem);

		expect(invalidateCachedVersion(ROOT, TARGET, fileSystem)).toBeTrue();

		expect(volume.existsSync(CACHE_PATH)).toBeFalse();
	});

	it("should degrade to a miss when the cache file is malformed", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile(volume, fileSystem);

		volume.fromJSON({ "/repo/game.rbxl": "place-bytes", [CACHE_PATH]: "{not json" });

		expect(readCachedVersion(ROOT, TARGET, hash, fileSystem)).toBeUndefined();
	});

	it("should degrade to a miss when the cache file has a newer format version", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile(volume, fileSystem);

		volume.fromJSON({
			"/repo/game.rbxl": "place-bytes",
			[CACHE_PATH]: JSON.stringify({
				entries: { anything: { hash, versionNumber: 42 } },
				version: 99,
			}),
		});

		expect(readCachedVersion(ROOT, TARGET, hash, fileSystem)).toBeUndefined();
	});

	/**
	 * An entry now claims the bytes boot, which only a boot probe can say. A
	 * file written before the probe existed makes no such claim, so serving it
	 * would skip the probe on a version nothing ever started.
	 */
	it("should degrade to a miss when the cache file predates boot verification", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile(volume, fileSystem);

		volume.fromJSON({
			"/repo/game.rbxl": "place-bytes",
			[CACHE_PATH]: JSON.stringify({
				entries: { "111/222//repo/game.rbxl": { hash, versionNumber: 42 } },
				version: 1,
			}),
		});

		expect(readCachedVersion(ROOT, TARGET, hash, fileSystem)).toBeUndefined();
	});

	it("should degrade to a miss when entries is not an object", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile(volume, fileSystem);

		volume.fromJSON({
			"/repo/game.rbxl": "place-bytes",
			[CACHE_PATH]: JSON.stringify({ entries: 7, version: 2 }),
		});

		expect(readCachedVersion(ROOT, TARGET, hash, fileSystem)).toBeUndefined();
	});

	it("should skip an entry whose shape is junk", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile(volume, fileSystem);

		volume.fromJSON({
			"/repo/game.rbxl": "place-bytes",
			[CACHE_PATH]: JSON.stringify({ entries: { junk: 7 }, version: 2 }),
		});

		expect(readCachedVersion(ROOT, TARGET, hash, fileSystem)).toBeUndefined();
	});

	it("should retain valid entries alongside a junk entry", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile(volume, fileSystem);

		volume.fromJSON({
			"/repo/game.rbxl": "place-bytes",
			[CACHE_PATH]: JSON.stringify({
				entries: {
					"111/222//repo/game.rbxl": { hash, versionNumber: 42 },
					"junk": 7,
				},
				version: 2,
			}),
		});

		expect(readCachedVersion(ROOT, TARGET, hash, fileSystem)).toBe(42);
	});
});
