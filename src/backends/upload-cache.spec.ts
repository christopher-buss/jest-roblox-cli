import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import {
	hashPlaceFile,
	invalidateCachedVersion,
	invalidateIfBehindHead,
	readCachedVersion,
	type UploadCacheTarget,
	writeCachedVersion,
} from "./upload-cache.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

const ROOT = "/repo";
const CACHE_PATH = "/repo/.jest-roblox/upload-cache.json";

const TARGET: UploadCacheTarget = {
	placeFilePath: "/repo/game.rbxl",
	placeId: "222",
	universeId: "111",
};

/** Seeds the place file and returns its hash, resetting the volume after. */
function seedPlaceFile(contents = "place-bytes"): string {
	onTestFinished(() => {
		vol.reset();
	});
	vol.fromJSON({ "/repo/game.rbxl": contents });

	return hashPlaceFile(TARGET.placeFilePath)!;
}

describe(hashPlaceFile, () => {
	it("should return undefined when the place file cannot be read", () => {
		expect.assertions(1);

		expect(hashPlaceFile("/repo/missing.rbxl")).toBeUndefined();
	});

	it("should return a different hash when the bytes change", () => {
		expect.assertions(1);

		const first = seedPlaceFile("one");
		const second = seedPlaceFile("two");

		expect(first).not.toBe(second);
	});
});

describe("upload cache", () => {
	it("should return undefined when nothing was ever cached", () => {
		expect.assertions(1);

		const hash = seedPlaceFile();

		expect(readCachedVersion(ROOT, TARGET, hash)).toBeUndefined();
	});

	it("should return the recorded version for the same bytes", () => {
		expect.assertions(1);

		const hash = seedPlaceFile();
		writeCachedVersion(ROOT, TARGET, hash, 42);

		expect(readCachedVersion(ROOT, TARGET, hash)).toBe(42);
	});

	it("should miss when the bytes changed", () => {
		expect.assertions(1);

		const hash = seedPlaceFile("one");
		writeCachedVersion(ROOT, TARGET, hash, 42);

		expect(readCachedVersion(ROOT, TARGET, seedPlaceFile("two"))).toBeUndefined();
	});

	it("should miss when the same bytes target a different place", () => {
		expect.assertions(2);

		const hash = seedPlaceFile();
		writeCachedVersion(ROOT, TARGET, hash, 42);

		expect(readCachedVersion(ROOT, { ...TARGET, placeId: "999" }, hash)).toBeUndefined();
		expect(readCachedVersion(ROOT, { ...TARGET, universeId: "999" }, hash)).toBeUndefined();
	});

	it("should replace the entry for a place file rather than adding one", () => {
		expect.assertions(2);

		const stale = seedPlaceFile("one");
		writeCachedVersion(ROOT, TARGET, stale, 42);
		writeCachedVersion(ROOT, TARGET, seedPlaceFile("two"), 43);

		// The superseded hash must not still resolve — otherwise the file grows
		// without bound and old bytes keep a version alive.
		expect(readCachedVersion(ROOT, TARGET, stale)).toBeUndefined();
		expect(readCachedVersion(ROOT, TARGET, seedPlaceFile("two"))).toBe(43);
	});

	it("should keep entries for different place files side by side", () => {
		expect.assertions(2);

		const hash = seedPlaceFile();
		const other: UploadCacheTarget = { ...TARGET, placeFilePath: "/repo/other.rbxl" };
		writeCachedVersion(ROOT, TARGET, hash, 42);
		writeCachedVersion(ROOT, other, hash, 43);

		expect(readCachedVersion(ROOT, TARGET, hash)).toBe(42);
		expect(readCachedVersion(ROOT, other, hash)).toBe(43);
	});

	it("should drop the entry on invalidate", () => {
		expect.assertions(1);

		const hash = seedPlaceFile();
		writeCachedVersion(ROOT, TARGET, hash, 42);
		invalidateCachedVersion(ROOT, TARGET);

		expect(readCachedVersion(ROOT, TARGET, hash)).toBeUndefined();
	});

	/**
	 * The one rule that decides whether a reused version is still valid. Open
	 * Cloud will not say which version is head, so a task that booted past the
	 * reused one is the whole of the evidence.
	 */
	it("should drop the entry when a task booted past the reused version", () => {
		expect.assertions(2);

		const hash = seedPlaceFile();
		writeCachedVersion(ROOT, TARGET, hash, 42);

		expect(
			invalidateIfBehindHead(ROOT, TARGET, { bootedVersion: 43, reusedVersion: 42 }),
		).toBeTrue();
		expect(readCachedVersion(ROOT, TARGET, hash)).toBeUndefined();
	});

	it("should keep the entry when a task booted the reused version or older", () => {
		expect.assertions(3);

		const hash = seedPlaceFile();
		writeCachedVersion(ROOT, TARGET, hash, 42);

		expect(
			invalidateIfBehindHead(ROOT, TARGET, { bootedVersion: 41, reusedVersion: 42 }),
		).toBeFalse();
		expect(
			invalidateIfBehindHead(ROOT, TARGET, { bootedVersion: 42, reusedVersion: 42 }),
		).toBeFalse();
		expect(readCachedVersion(ROOT, TARGET, hash)).toBe(42);
	});

	/**
	 * A write that fails leaves the entry in the file, so it is still the one
	 * the next run reads. The caller says so out loud rather than promising a
	 * re-upload that will not happen.
	 */
	it("should report a stale entry as surviving when the cache cannot be written", async () => {
		expect.assertions(2);

		const hash = seedPlaceFile();
		writeCachedVersion(ROOT, TARGET, hash, 42);
		const fs = await import("node:fs");
		vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
			throw new Error("EROFS: read-only file system");
		});

		expect(
			invalidateIfBehindHead(ROOT, TARGET, { bootedVersion: 43, reusedVersion: 42 }),
		).toBeFalse();
		expect(readCachedVersion(ROOT, TARGET, hash)).toBe(42);
	});

	it("should tolerate invalidating when no cache file exists", () => {
		expect.assertions(1);

		seedPlaceFile();

		expect(() => {
			invalidateCachedVersion(ROOT, TARGET);
		}).not.toThrow();
	});

	it("should degrade to a miss when the cache file is malformed", () => {
		expect.assertions(1);

		const hash = seedPlaceFile();
		vol.fromJSON({ "/repo/game.rbxl": "place-bytes", [CACHE_PATH]: "{not json" });

		expect(readCachedVersion(ROOT, TARGET, hash)).toBeUndefined();
	});

	it("should degrade to a miss when the cache file has a newer format version", () => {
		expect.assertions(1);

		const hash = seedPlaceFile();
		vol.fromJSON({
			"/repo/game.rbxl": "place-bytes",
			[CACHE_PATH]: JSON.stringify({
				entries: { anything: { hash, versionNumber: 42 } },
				version: 99,
			}),
		});

		expect(readCachedVersion(ROOT, TARGET, hash)).toBeUndefined();
	});

	it("should degrade to a miss when entries is not an object", () => {
		expect.assertions(1);

		const hash = seedPlaceFile();
		vol.fromJSON({
			"/repo/game.rbxl": "place-bytes",
			[CACHE_PATH]: JSON.stringify({ entries: 7, version: 1 }),
		});

		expect(readCachedVersion(ROOT, TARGET, hash)).toBeUndefined();
	});

	it("should skip an entry whose shape is junk", () => {
		expect.assertions(1);

		const hash = seedPlaceFile();
		vol.fromJSON({
			"/repo/game.rbxl": "place-bytes",
			[CACHE_PATH]: JSON.stringify({ entries: { junk: 7 }, version: 1 }),
		});

		expect(readCachedVersion(ROOT, TARGET, hash)).toBeUndefined();
	});

	it("should retain valid entries alongside a junk entry", () => {
		expect.assertions(1);

		const hash = seedPlaceFile();
		vol.fromJSON({
			"/repo/game.rbxl": "place-bytes",
			[CACHE_PATH]: JSON.stringify({
				entries: {
					"111/222//repo/game.rbxl": { hash, versionNumber: 42 },
					"junk": 7,
				},
				version: 1,
			}),
		});

		expect(readCachedVersion(ROOT, TARGET, hash)).toBe(42);
	});
});
