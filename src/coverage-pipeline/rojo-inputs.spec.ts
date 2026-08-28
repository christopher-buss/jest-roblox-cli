import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as fs from "node:fs";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { writeAgedFile } from "../../test/mocks/aged-file.ts";
import { computeRojoInputsHashAsync } from "./rojo-inputs.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

const PROJECT = "/project/default.project.json";
const DIGEST_CACHE = "/project/.jest-roblox/input-digests";

function reset(): void {
	onTestFinished(() => {
		vol.reset();
	});
}

function writeProject(tree: JSONObject): void {
	vol.mkdirSync("/project", { recursive: true });
	vol.writeFileSync(PROJECT, JSON.stringify({ name: "test", tree }));
}

function writeRawProject(contents: string): void {
	vol.mkdirSync("/project", { recursive: true });
	vol.writeFileSync(PROJECT, contents);
}

async function hashOfAsync(luauRoots: Array<string> = [], projectJson?: string): Promise<string> {
	return computeRojoInputsHashAsync({
		digestCacheFile: DIGEST_CACHE,
		luauRoots,
		projectJson,
		rojoProjectPath: PROJECT,
		rootDirectory: "/project",
	});
}

describe(computeRojoInputsHashAsync, () => {
	it("should reuse recorded digests rather than re-read an unchanged mount", async () => {
		expect.assertions(2);

		reset();
		writeProject({ $className: "DataModel", Inc: { $path: "include" } });
		vol.mkdirSync("/project/include", { recursive: true });
		writeAgedFile("/project/include/a.lua", "-- v1");
		const before = await hashOfAsync();

		const readFile = vi.spyOn(fs.promises, "readFile");

		await expect(hashOfAsync()).resolves.toBe(before);
		expect(readFile).not.toHaveBeenCalledWith("/project/include/a.lua");
	});

	it("should still move when a file changes under a warm digest cache", async () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Inc: { $path: "include" } });
		vol.mkdirSync("/project/include", { recursive: true });
		writeAgedFile("/project/include/a.lua", "-- v1");
		const before = await hashOfAsync();

		writeAgedFile("/project/include/a.lua", "-- v2 is longer");

		await expect(hashOfAsync()).resolves.not.toBe(before);
	});

	it("should hash the same tree the same wherever the root sits", async () => {
		expect.assertions(1);

		reset();
		// Relative to the root and nothing else, so a checkout moved to another
		// directory reuses its place rather than rebuilding it.
		vol.mkdirSync("/elsewhere/include", { recursive: true });
		const projectText = JSON.stringify({
			name: "test",
			tree: { $className: "DataModel", Inc: { $path: "include" } },
		});
		vol.writeFileSync("/elsewhere/default.project.json", projectText);
		writeAgedFile("/elsewhere/include/a.lua", "-- v1");
		vol.mkdirSync("/project/include", { recursive: true });
		vol.writeFileSync(PROJECT, projectText);
		writeAgedFile("/project/include/a.lua", "-- v1");

		await expect(
			computeRojoInputsHashAsync({
				digestCacheFile: "/elsewhere/.jest-roblox/input-digests",
				luauRoots: [],
				rojoProjectPath: "/elsewhere/default.project.json",
				rootDirectory: "/elsewhere",
			}),
		).resolves.toBe(await hashOfAsync());
	});

	it("should hash the project text the caller holds rather than the file on disk", async () => {
		expect.assertions(2);

		reset();
		vol.mkdirSync("/project/include", { recursive: true });
		vol.writeFileSync("/project/include/a.lua", "x");
		// Nothing at PROJECT: the caller has not written the project yet, and
		// hashing it off disk would throw rather than answer.
		const held = JSON.stringify({
			name: "test",
			tree: { $className: "DataModel", Inc: { $path: "include" } },
		});

		const first = await hashOfAsync([], held);

		expect(first).toMatch(/^[a-f0-9]{64}$/);
		// Same tree, different bytes: the text is the input, not what it parses
		// to, so a whitespace-only edit still moves the digest.
		await expect(hashOfAsync([], `${held} `)).resolves.not.toBe(first);
	});

	it("should return a sha256 digest", async () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel" });

		await expect(hashOfAsync()).resolves.toMatch(/^[a-f0-9]{64}$/);
	});

	it("should be stable when nothing changes", async () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Inc: { $path: "include" } });
		vol.mkdirSync("/project/include", { recursive: true });
		vol.writeFileSync("/project/include/RuntimeLib.lua", "-- v1");

		await expect(hashOfAsync()).resolves.toBe(await hashOfAsync());
	});

	it("should change when a mounted directory's file content changes", async () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Inc: { $path: "include" } });
		vol.mkdirSync("/project/include", { recursive: true });
		vol.writeFileSync("/project/include/RuntimeLib.lua", "-- v1");
		const before = await hashOfAsync();

		vol.writeFileSync("/project/include/RuntimeLib.lua", "-- v2");

		await expect(hashOfAsync()).resolves.not.toBe(before);
	});

	it("should change when a directly mounted file changes", async () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Lib: { $path: "include/RuntimeLib.lua" } });
		vol.mkdirSync("/project/include", { recursive: true });
		vol.writeFileSync("/project/include/RuntimeLib.lua", "-- v1");
		const before = await hashOfAsync();

		vol.writeFileSync("/project/include/RuntimeLib.lua", "-- v2");

		await expect(hashOfAsync()).resolves.not.toBe(before);
	});

	it("should change when the rojo project file itself changes", async () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel" });
		const before = await hashOfAsync();

		writeProject({ $className: "DataModel", $ignoreUnknownInstances: true });

		await expect(hashOfAsync()).resolves.not.toBe(before);
	});

	it("should change when an inlined nested project file changes", async () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Pkg: { $path: "pkg" } });
		vol.mkdirSync("/project/pkg", { recursive: true });
		vol.writeFileSync(
			"/project/pkg/default.project.json",
			JSON.stringify({ name: "pkg-a", tree: { $path: "src" } }),
		);
		vol.mkdirSync("/project/pkg/src", { recursive: true });
		const before = await hashOfAsync();

		vol.writeFileSync(
			"/project/pkg/default.project.json",
			JSON.stringify({ name: "pkg-b", tree: { $path: "src" } }),
		);

		await expect(hashOfAsync()).resolves.not.toBe(before);
	});

	it("should change when a file under an absolute mount changes", async () => {
		expect.assertions(1);

		reset();
		// Rojo mounts an absolute `$path` as written, so the walk reaches it
		// there rather than under the project directory.
		writeProject({ $className: "DataModel", Ext: { $path: "/external/out" } });
		vol.mkdirSync("/external/out", { recursive: true });
		vol.writeFileSync("/external/out/a.luau", "local a = 1");
		const before = await hashOfAsync();

		vol.writeFileSync("/external/out/a.luau", "local a = 2");

		await expect(hashOfAsync()).resolves.not.toBe(before);
	});

	it("should exclude mounts that are or are nested under a luauRoot", async () => {
		expect.assertions(2);

		reset();
		writeProject({
			$className: "DataModel",
			Inc: { $path: "include" },
			Nested: { $path: "out/nested" },
			Out: { $path: "out" },
		});
		vol.mkdirSync("/project/out/nested", { recursive: true });
		vol.writeFileSync("/project/out/a.luau", "local a = 1");
		vol.writeFileSync("/project/out/nested/b.luau", "local b = 1");
		vol.mkdirSync("/project/include", { recursive: true });
		vol.writeFileSync("/project/include/x.lua", "-- x");
		const before = await hashOfAsync(["out"]);

		vol.writeFileSync("/project/out/a.luau", "local a = 2");
		vol.writeFileSync("/project/out/nested/b.luau", "local b = 2");
		const afterLuauRootEdits = await hashOfAsync(["out"]);

		vol.writeFileSync("/project/include/x.lua", "-- changed");
		const afterIncludeEdit = await hashOfAsync(["out"]);

		expect(afterLuauRootEdits).toBe(before);
		expect(afterIncludeEdit).not.toBe(before);
	});

	it("should skip dot-prefixed entries inside a mount", async () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Inc: { $path: "include" } });
		vol.mkdirSync("/project/include/.cache", { recursive: true });
		vol.writeFileSync("/project/include/.cache/junk", "v1");
		vol.writeFileSync("/project/include/a.lua", "x");
		const before = await hashOfAsync();

		vol.writeFileSync("/project/include/.cache/junk", "v2");

		await expect(hashOfAsync()).resolves.toBe(before);
	});

	it("should drop mounts that do not exist on disk", async () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Ghost: { $path: "ghost" } });

		await expect(hashOfAsync()).resolves.toMatch(/^[a-f0-9]{64}$/);
	});

	it("should change when a file is moved with identical content", async () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Inc: { $path: "include" } });
		vol.mkdirSync("/project/include", { recursive: true });
		vol.writeFileSync("/project/include/a.lua", "same");
		const before = await hashOfAsync();

		vol.unlinkSync("/project/include/a.lua");
		vol.writeFileSync("/project/include/b.lua", "same");

		await expect(hashOfAsync()).resolves.not.toBe(before);
	});

	it("should hash a file reached through a symlinked directory", async () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Inc: { $path: "include" } });
		vol.mkdirSync("/project/include", { recursive: true });
		vol.mkdirSync("/shared", { recursive: true });
		vol.writeFileSync("/shared/a.lua", "v1");
		vol.symlinkSync("/shared", "/project/include/linked");
		const before = await hashOfAsync();

		vol.writeFileSync("/shared/a.lua", "v2");

		await expect(hashOfAsync()).resolves.not.toBe(before);
	});

	it("should hash a file a mount reaches only by following a symlink", async () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Inc: { $path: "linked" } });
		vol.mkdirSync("/shared/nested", { recursive: true });
		vol.writeFileSync("/shared/nested/a.lua", "v1");
		vol.mkdirSync("/project", { recursive: true });
		vol.symlinkSync("/shared", "/project/linked");
		const before = await hashOfAsync();

		vol.writeFileSync("/shared/nested/a.lua", "v2");

		await expect(hashOfAsync()).resolves.not.toBe(before);
	});

	it("should terminate on a symlink cycle", async () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Inc: { $path: "include" } });
		vol.mkdirSync("/project/include", { recursive: true });
		vol.writeFileSync("/project/include/a.lua", "x");
		vol.symlinkSync("/project/include", "/project/include/loop");

		await expect(hashOfAsync()).resolves.toMatch(/^[a-f0-9]{64}$/);
	});

	describe("when the project file has no tree object", () => {
		it("should throw when the project is not a JSON object", async () => {
			expect.assertions(1);

			reset();
			writeRawProject('"just a string"');

			await expect(hashOfAsync()).rejects.toThrowWithMessage(Error, /Invalid Rojo project/);
		});

		it("should throw when the project is JSON null", async () => {
			expect.assertions(1);

			reset();
			writeRawProject("null");

			await expect(hashOfAsync()).rejects.toThrowWithMessage(Error, /Invalid Rojo project/);
		});

		it("should throw when the project is a JSON array", async () => {
			expect.assertions(1);

			reset();
			writeRawProject("[]");

			await expect(hashOfAsync()).rejects.toThrowWithMessage(Error, /Invalid Rojo project/);
		});

		it("should throw when tree is missing", async () => {
			expect.assertions(1);

			reset();
			writeRawProject('{ "name": "test" }');

			await expect(hashOfAsync()).rejects.toThrowWithMessage(Error, /Invalid Rojo project/);
		});

		it("should throw when tree is an array", async () => {
			expect.assertions(1);

			reset();
			writeRawProject('{ "name": "test", "tree": [] }');

			await expect(hashOfAsync()).rejects.toThrowWithMessage(Error, /Invalid Rojo project/);
		});
	});

	it("should pass over a luauRoot nested inside a mounted directory", async () => {
		expect.assertions(2);

		reset();
		writeProject({ $className: "DataModel", Out: { $path: "out" } });
		vol.mkdirSync("/project/out/modules/ecs", { recursive: true });
		vol.mkdirSync("/project/out/client", { recursive: true });
		vol.writeFileSync("/project/out/modules/ecs/world.luau", "-- v1");
		vol.writeFileSync("/project/out/client/button.luau", "-- v1");
		const before = await hashOfAsync(["out/modules/ecs"]);

		// The shadow diff content-hashes the root itself, so re-reading it here
		// would double the work the narrowing exists to avoid.
		vol.writeFileSync("/project/out/modules/ecs/world.luau", "-- v2");

		await expect(hashOfAsync(["out/modules/ecs"])).resolves.toBe(before);

		vol.writeFileSync("/project/out/client/button.luau", "-- v2");

		await expect(hashOfAsync(["out/modules/ecs"])).resolves.not.toBe(before);
	});
});
