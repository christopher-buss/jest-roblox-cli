import { describe, expect, it, vi } from "vitest";

import { ageFile, writeAgedFile } from "../../test/mocks/aged-file.ts";
import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { hashString } from "./hash.ts";
import { openInputDigestCache } from "./input-digest-cache.ts";

const CACHE_FILE = "/project/.jest-roblox/input-digests";

describe(openInputDigestCache, () => {
	it("should report the sha256 of the file's bytes", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		writeAgedFile(fileSystem, "/project/a.lua", "-- v1");

		const cache = openInputDigestCache(CACHE_FILE, fileSystem);

		await expect(cache.hashOfAsync("/project/a.lua")).resolves.toBe(hashString("-- v1"));
	});

	it("should reuse a recorded digest instead of re-reading unchanged bytes", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();
		writeAgedFile(fileSystem, "/project/a.lua", "-- v1");
		const first = openInputDigestCache(CACHE_FILE, fileSystem);
		const recorded = await first.hashOfAsync("/project/a.lua");
		first.save();

		const second = openInputDigestCache(CACHE_FILE, fileSystem);
		const readFile = vi.spyOn(fileSystem.promises, "readFile");

		await expect(second.hashOfAsync("/project/a.lua")).resolves.toBe(recorded);
		expect(readFile).not.toHaveBeenCalledWith("/project/a.lua");
	});

	it("should re-read a file whose bytes changed since the last run", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		writeAgedFile(fileSystem, "/project/a.lua", "-- v1");
		const first = openInputDigestCache(CACHE_FILE, fileSystem);
		await first.hashOfAsync("/project/a.lua");
		first.save();
		writeAgedFile(fileSystem, "/project/a.lua", "-- v2 is longer");

		await expect(
			openInputDigestCache(CACHE_FILE, fileSystem).hashOfAsync("/project/a.lua"),
		).resolves.toBe(hashString("-- v2 is longer"));
	});

	it("should re-read a same-size file whose mtime moved", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		writeAgedFile(fileSystem, "/project/a.lua", "-- v1");
		const first = openInputDigestCache(CACHE_FILE, fileSystem);
		await first.hashOfAsync("/project/a.lua");
		first.save();
		// Same byte count, so only the timestamp separates the two states.
		writeAgedFile(fileSystem, "/project/a.lua", "-- v2");
		ageFile(fileSystem, "/project/a.lua", 30);

		await expect(
			openInputDigestCache(CACHE_FILE, fileSystem).hashOfAsync("/project/a.lua"),
		).resolves.toBe(hashString("-- v2"));
	});

	it("should not record a digest for a file written during the run", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		const first = openInputDigestCache(CACHE_FILE, fileSystem);
		// No back-dating: the file lands no earlier than the run that reads it,
		// so its timestamp cannot prove the bytes stayed put afterwards.
		volume.mkdirSync("/project", { recursive: true });
		volume.writeFileSync("/project/a.lua", "-- v1");
		await first.hashOfAsync("/project/a.lua");
		first.save();

		const second = openInputDigestCache(CACHE_FILE, fileSystem);
		const readFile = vi.spyOn(fileSystem.promises, "readFile");
		await second.hashOfAsync("/project/a.lua");

		expect(readFile).toHaveBeenCalledWith("/project/a.lua");
	});

	it("should not record a path a line cannot hold", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		// A newline is legal in a POSIX filename. Recorded as one line it would
		// split in two, and the tail would be read as an entry for whatever
		// path it happens to spell.
		writeAgedFile(fileSystem, "/project/one\ntwo.lua", "-- v1");
		const first = openInputDigestCache(CACHE_FILE, fileSystem);
		await first.hashOfAsync("/project/one\ntwo.lua");
		first.save();

		expect(volume.readFileSync(CACHE_FILE, "utf-8")).toBe("v1");
	});

	it("should forget a file the latest run did not look at", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		writeAgedFile(fileSystem, "/project/a.lua", "-- a");
		writeAgedFile(fileSystem, "/project/b.lua", "-- b");
		const first = openInputDigestCache(CACHE_FILE, fileSystem);
		await first.hashOfAsync("/project/a.lua");
		await first.hashOfAsync("/project/b.lua");
		first.save();

		// A narrower walk: b.lua leaves the input set, and with it the cache.
		const second = openInputDigestCache(CACHE_FILE, fileSystem);
		await second.hashOfAsync("/project/a.lua");
		second.save();

		const third = openInputDigestCache(CACHE_FILE, fileSystem);
		const readFile = vi.spyOn(fileSystem.promises, "readFile");
		await third.hashOfAsync("/project/b.lua");

		expect(readFile).toHaveBeenCalledWith("/project/b.lua");
	});

	it("should ignore a cache written in another format", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		writeAgedFile(fileSystem, "/project/a.lua", "-- v1");
		// Stat fields this reader would accept, carrying a digest from a layout
		// it can no longer read. Only the version marker separates the two.
		const stats = volume.statSync("/project/a.lua");
		volume.mkdirSync("/project/.jest-roblox", { recursive: true });
		const stale = ["/project/a.lua", stats.size, stats.mtimeMs, "stale"].join("\0");
		volume.writeFileSync(CACHE_FILE, `v0\n${stale}`);

		await expect(
			openInputDigestCache(CACHE_FILE, fileSystem).hashOfAsync("/project/a.lua"),
		).resolves.toBe(hashString("-- v1"));
	});

	it("should re-read past a corrupt line rather than trust it", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		writeAgedFile(fileSystem, "/project/a.lua", "-- v1");
		volume.mkdirSync("/project/.jest-roblox", { recursive: true });
		// The fields are positional, so a line missing its tail leaves nothing
		// a stat can match against.
		volume.writeFileSync(CACHE_FILE, "v1\n/project/a.lua");

		await expect(
			openInputDigestCache(CACHE_FILE, fileSystem).hashOfAsync("/project/a.lua"),
		).resolves.toBe(hashString("-- v1"));
	});

	it("should leave the previous record in place when nothing was read", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		writeAgedFile(fileSystem, "/project/a.lua", "-- v1");
		const first = openInputDigestCache(CACHE_FILE, fileSystem);
		await first.hashOfAsync("/project/a.lua");
		first.save();

		const second = openInputDigestCache(CACHE_FILE, fileSystem);
		await second.hashOfAsync("/project/a.lua");
		// atomicWrite publishes by rename, so a rename is the record being
		// replaced by one it already matched.
		const rename = vi.spyOn(fileSystem, "renameSync");
		second.save();

		expect(rename).not.toHaveBeenCalled();
	});

	it("should record a re-read so the run after it can skip one", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		writeAgedFile(fileSystem, "/project/a.lua", "-- v1");
		const first = openInputDigestCache(CACHE_FILE, fileSystem);
		await first.hashOfAsync("/project/a.lua");
		first.save();

		writeAgedFile(fileSystem, "/project/a.lua", "-- v2 is longer");
		const second = openInputDigestCache(CACHE_FILE, fileSystem);
		await second.hashOfAsync("/project/a.lua");
		second.save();

		const third = openInputDigestCache(CACHE_FILE, fileSystem);
		const readFile = vi.spyOn(fileSystem.promises, "readFile");
		await third.hashOfAsync("/project/a.lua");

		expect(readFile).not.toHaveBeenCalledWith("/project/a.lua");
	});
});
