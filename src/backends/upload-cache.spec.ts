import { describe, expect, it, vi } from "vitest";

import type { MemoryVolume } from "../../test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { FileSystem } from "../utils/file-system.ts";
import {
	hashPlaceFile,
	invalidateCachedVersion,
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
function seedPlaceFile({
	contents = "place-bytes",
	fileSystem,
	volume,
}: {
	readonly contents?: string;
	readonly fileSystem: FileSystem;
	readonly volume: MemoryVolume;
}): string {
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

		const first = seedPlaceFile({ contents: "one", fileSystem, volume });
		const second = seedPlaceFile({ contents: "two", fileSystem, volume });

		expect(first).not.toBe(second);
	});
});

describe("upload cache", () => {
	it("should return undefined when nothing was ever cached", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile({ fileSystem, volume });

		expect(
			readCachedVersion({ fileSystem, hash, rootDirectory: ROOT, target: TARGET }),
		).toBeUndefined();
	});

	it("should return the recorded version for the same bytes", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile({ fileSystem, volume });

		writeCachedVersion({
			entry: { hash, versionNumber: 42 },
			fileSystem,
			rootDirectory: ROOT,
			target: TARGET,
		});

		expect(readCachedVersion({ fileSystem, hash, rootDirectory: ROOT, target: TARGET })).toBe(
			42,
		);
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

		const hash = seedPlaceFile({ contents: "one", fileSystem, volume });
		writeCachedVersion({
			entry: { hash, versionNumber: 42 },
			fileSystem,
			rootDirectory: ROOT,
			target: TARGET,
		});

		expect(
			readCachedVersion({
				fileSystem,
				hash: seedPlaceFile({ contents: "two", fileSystem, volume }),
				rootDirectory: ROOT,
				target: TARGET,
			}),
		).toBeUndefined();
	});

	it("should miss when the same bytes target a different place", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile({ fileSystem, volume });
		writeCachedVersion({
			entry: { hash, versionNumber: 42 },
			fileSystem,
			rootDirectory: ROOT,
			target: TARGET,
		});

		expect(
			readCachedVersion({
				fileSystem,
				hash,
				rootDirectory: ROOT,
				target: { ...TARGET, placeId: "999" },
			}),
		).toBeUndefined();
		expect(
			readCachedVersion({
				fileSystem,
				hash,
				rootDirectory: ROOT,
				target: { ...TARGET, universeId: "999" },
			}),
		).toBeUndefined();
	});

	it("should replace the entry for a place file rather than adding one", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const stale = seedPlaceFile({ contents: "one", fileSystem, volume });
		writeCachedVersion({
			entry: { hash: stale, versionNumber: 42 },
			fileSystem,
			rootDirectory: ROOT,
			target: TARGET,
		});
		writeCachedVersion({
			entry: {
				hash: seedPlaceFile({ contents: "two", fileSystem, volume }),
				versionNumber: 43,
			},
			fileSystem,
			rootDirectory: ROOT,
			target: TARGET,
		});

		// The superseded hash must not still resolve — otherwise the file grows
		// without bound and old bytes keep a version alive.
		expect(
			readCachedVersion({ fileSystem, hash: stale, rootDirectory: ROOT, target: TARGET }),
		).toBeUndefined();
		expect(
			readCachedVersion({
				fileSystem,
				hash: seedPlaceFile({ contents: "two", fileSystem, volume }),
				rootDirectory: ROOT,
				target: TARGET,
			}),
		).toBe(43);
	});

	it("should keep entries for different place files side by side", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile({ fileSystem, volume });
		const other: UploadCacheTarget = { ...TARGET, placeFilePath: "/repo/other.rbxl" };
		writeCachedVersion({
			entry: { hash, versionNumber: 42 },
			fileSystem,
			rootDirectory: ROOT,
			target: TARGET,
		});
		writeCachedVersion({
			entry: { hash, versionNumber: 43 },
			fileSystem,
			rootDirectory: ROOT,
			target: other,
		});

		expect(readCachedVersion({ fileSystem, hash, rootDirectory: ROOT, target: TARGET })).toBe(
			42,
		);
		expect(readCachedVersion({ fileSystem, hash, rootDirectory: ROOT, target: other })).toBe(
			43,
		);
	});

	it("should drop the entry on invalidate", () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile({ fileSystem, volume });

		writeCachedVersion({
			entry: { hash, versionNumber: 42 },
			fileSystem,
			rootDirectory: ROOT,
			target: TARGET,
		});

		expect(
			invalidateCachedVersion({ fileSystem, rootDirectory: ROOT, target: TARGET }),
		).toBeTrue();
		expect(
			readCachedVersion({ fileSystem, hash, rootDirectory: ROOT, target: TARGET }),
		).toBeUndefined();
		expect(volume.readFileSync(CACHE_PATH, "utf8")).toBe(
			JSON.stringify({ entries: {}, version: 2 }, undefined, "\t"),
		);
	});

	/**
	 * A write that fails leaves the entry in the file, so it is still the one
	 * the next run reads. The caller says so out loud rather than promising a
	 * re-upload that will not happen.
	 */
	it("should report a stale entry as surviving when the cache cannot be written", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile({ fileSystem, volume });
		writeCachedVersion({
			entry: { hash, versionNumber: 42 },
			fileSystem,
			rootDirectory: ROOT,
			target: TARGET,
		});
		vi.spyOn(fileSystem, "writeFileSync").mockImplementation(() => {
			throw new Error("EROFS: read-only file system");
		});

		expect(
			invalidateCachedVersion({ fileSystem, rootDirectory: ROOT, target: TARGET }),
		).toBeFalse();
		expect(readCachedVersion({ fileSystem, hash, rootDirectory: ROOT, target: TARGET })).toBe(
			42,
		);
	});

	it("should tolerate invalidating when no cache file exists", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedPlaceFile({ fileSystem, volume });

		expect(
			invalidateCachedVersion({ fileSystem, rootDirectory: ROOT, target: TARGET }),
		).toBeTrue();

		expect(volume.existsSync(CACHE_PATH)).toBeFalse();
	});

	it("should degrade to a miss when the cache file is malformed", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile({ fileSystem, volume });

		volume.fromJSON({ "/repo/game.rbxl": "place-bytes", [CACHE_PATH]: "{not json" });

		expect(
			readCachedVersion({ fileSystem, hash, rootDirectory: ROOT, target: TARGET }),
		).toBeUndefined();
	});

	it("should degrade to a miss when the cache file has a newer format version", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile({ fileSystem, volume });

		volume.fromJSON({
			"/repo/game.rbxl": "place-bytes",
			[CACHE_PATH]: JSON.stringify({
				entries: { anything: { hash, versionNumber: 42 } },
				version: 99,
			}),
		});

		expect(
			readCachedVersion({ fileSystem, hash, rootDirectory: ROOT, target: TARGET }),
		).toBeUndefined();
	});

	/**
	 * An entry now claims the bytes boot, which only a boot probe can say. A
	 * file written before the probe existed makes no such claim, so serving it
	 * would skip the probe on a version nothing ever started.
	 */
	it("should degrade to a miss when the cache file predates boot verification", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile({ fileSystem, volume });

		volume.fromJSON({
			"/repo/game.rbxl": "place-bytes",
			[CACHE_PATH]: JSON.stringify({
				entries: { "111/222//repo/game.rbxl": { hash, versionNumber: 42 } },
				version: 1,
			}),
		});

		expect(
			readCachedVersion({ fileSystem, hash, rootDirectory: ROOT, target: TARGET }),
		).toBeUndefined();
	});

	it("should degrade to a miss when entries is not an object", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile({ fileSystem, volume });

		volume.fromJSON({
			"/repo/game.rbxl": "place-bytes",
			[CACHE_PATH]: JSON.stringify({ entries: 7, version: 2 }),
		});

		expect(
			readCachedVersion({ fileSystem, hash, rootDirectory: ROOT, target: TARGET }),
		).toBeUndefined();
	});

	it("should skip an entry whose shape is junk", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile({ fileSystem, volume });

		volume.fromJSON({
			"/repo/game.rbxl": "place-bytes",
			[CACHE_PATH]: JSON.stringify({ entries: { junk: 7 }, version: 2 }),
		});

		expect(
			readCachedVersion({ fileSystem, hash, rootDirectory: ROOT, target: TARGET }),
		).toBeUndefined();
	});

	it("should retain valid entries alongside a junk entry", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const hash = seedPlaceFile({ fileSystem, volume });

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

		expect(readCachedVersion({ fileSystem, hash, rootDirectory: ROOT, target: TARGET })).toBe(
			42,
		);
	});
});
