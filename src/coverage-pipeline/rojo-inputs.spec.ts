import { describe, expect, it, vi } from "vitest";

import { writeAgedFile } from "../../test/mocks/aged-file.ts";
import type { MemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { computeRojoInputsHashAsync } from "./rojo-inputs.ts";

const PROJECT = "/project/default.project.json";
const DIGEST_CACHE = "/project/.jest-roblox/input-digests";

/**
 * A volume holding a rojo project written out verbatim.
 *
 * @param contents - The project file's bytes.
 */
function writeRawProject(contents: string): MemoryFileSystem {
	return createMemoryFileSystem({ [PROJECT]: contents });
}

/**
 * A volume holding a rojo project with `tree`.
 *
 * @param tree - The project tree the walk reads.
 */
function writeProject(tree: JSONObject): MemoryFileSystem {
	return writeRawProject(JSON.stringify({ name: "test", tree }));
}

async function hashOfAsync(
	fileSystem: FileSystem,
	luauRoots: Array<string> = [],
	projectJson?: string,
): Promise<string> {
	return computeRojoInputsHashAsync({
		digestCacheFile: DIGEST_CACHE,
		fileSystem,
		luauRoots,
		projectJson,
		rojoProjectPath: PROJECT,
		rootDirectory: "/project",
	});
}

describe(computeRojoInputsHashAsync, () => {
	it("should reuse recorded digests rather than re-read an unchanged mount", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = writeProject({
			$className: "DataModel",
			Inc: { $path: "include" },
		});
		volume.mkdirSync("/project/include", { recursive: true });
		writeAgedFile(fileSystem, "/project/include/a.lua", "-- v1");
		const before = await hashOfAsync(fileSystem);

		const readFile = vi.spyOn(fileSystem.promises, "readFile");

		await expect(hashOfAsync(fileSystem)).resolves.toBe(before);
		expect(readFile).not.toHaveBeenCalledWith("/project/include/a.lua");
	});

	it("should still move when a file changes under a warm digest cache", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = writeProject({
			$className: "DataModel",
			Inc: { $path: "include" },
		});
		volume.mkdirSync("/project/include", { recursive: true });
		writeAgedFile(fileSystem, "/project/include/a.lua", "-- v1");
		const before = await hashOfAsync(fileSystem);

		writeAgedFile(fileSystem, "/project/include/a.lua", "-- v2 is longer");

		await expect(hashOfAsync(fileSystem)).resolves.not.toBe(before);
	});

	it("should hash the same tree the same wherever the root sits", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		// Relative to the root and nothing else, so a checkout moved to another
		// directory reuses its place rather than rebuilding it.
		volume.mkdirSync("/elsewhere/include", { recursive: true });
		const projectText = JSON.stringify({
			name: "test",
			tree: { $className: "DataModel", Inc: { $path: "include" } },
		});
		volume.writeFileSync("/elsewhere/default.project.json", projectText);
		writeAgedFile(fileSystem, "/elsewhere/include/a.lua", "-- v1");
		volume.mkdirSync("/project/include", { recursive: true });
		volume.writeFileSync(PROJECT, projectText);
		writeAgedFile(fileSystem, "/project/include/a.lua", "-- v1");

		await expect(
			computeRojoInputsHashAsync({
				digestCacheFile: "/elsewhere/.jest-roblox/input-digests",
				fileSystem,
				luauRoots: [],
				rojoProjectPath: "/elsewhere/default.project.json",
				rootDirectory: "/elsewhere",
			}),
		).resolves.toBe(await hashOfAsync(fileSystem));
	});

	it("should hash the project text the caller holds rather than the file on disk", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/project/include", { recursive: true });
		volume.writeFileSync("/project/include/a.lua", "x");
		// Nothing at PROJECT: the caller has not written the project yet, and
		// hashing it off disk would throw rather than answer.
		const held = JSON.stringify({
			name: "test",
			tree: { $className: "DataModel", Inc: { $path: "include" } },
		});

		const first = await hashOfAsync(fileSystem, [], held);

		expect(first).toMatch(/^[a-f0-9]{64}$/);
		// Same tree, different bytes: the text is the input, not what it parses
		// to, so a whitespace-only edit still moves the digest.
		await expect(hashOfAsync(fileSystem, [], `${held} `)).resolves.not.toBe(first);
	});

	it("should return a sha256 digest", async () => {
		expect.assertions(1);

		const { fileSystem } = writeProject({ $className: "DataModel" });

		await expect(hashOfAsync(fileSystem)).resolves.toMatch(/^[a-f0-9]{64}$/);
	});

	it("should be stable when nothing changes", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = writeProject({
			$className: "DataModel",
			Inc: { $path: "include" },
		});
		volume.mkdirSync("/project/include", { recursive: true });
		volume.writeFileSync("/project/include/RuntimeLib.lua", "-- v1");

		await expect(hashOfAsync(fileSystem)).resolves.toBe(await hashOfAsync(fileSystem));
	});

	it("should change when a mounted directory's file content changes", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = writeProject({
			$className: "DataModel",
			Inc: { $path: "include" },
		});
		volume.mkdirSync("/project/include", { recursive: true });
		volume.writeFileSync("/project/include/RuntimeLib.lua", "-- v1");
		const before = await hashOfAsync(fileSystem);

		volume.writeFileSync("/project/include/RuntimeLib.lua", "-- v2");

		await expect(hashOfAsync(fileSystem)).resolves.not.toBe(before);
	});

	it("should change when a directly mounted file changes", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = writeProject({
			$className: "DataModel",
			Lib: { $path: "include/RuntimeLib.lua" },
		});
		volume.mkdirSync("/project/include", { recursive: true });
		volume.writeFileSync("/project/include/RuntimeLib.lua", "-- v1");
		const before = await hashOfAsync(fileSystem);

		volume.writeFileSync("/project/include/RuntimeLib.lua", "-- v2");

		await expect(hashOfAsync(fileSystem)).resolves.not.toBe(before);
	});

	it("should change when the rojo project file itself changes", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = writeProject({ $className: "DataModel" });
		const before = await hashOfAsync(fileSystem);

		volume.writeFileSync(
			PROJECT,
			JSON.stringify({
				name: "test",
				tree: { $className: "DataModel", $ignoreUnknownInstances: true },
			}),
		);

		await expect(hashOfAsync(fileSystem)).resolves.not.toBe(before);
	});

	it("should change when an inlined nested project file changes", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = writeProject({
			$className: "DataModel",
			Pkg: { $path: "pkg" },
		});
		volume.mkdirSync("/project/pkg", { recursive: true });
		volume.writeFileSync(
			"/project/pkg/default.project.json",
			JSON.stringify({ name: "pkg-a", tree: { $path: "src" } }),
		);
		volume.mkdirSync("/project/pkg/src", { recursive: true });
		const before = await hashOfAsync(fileSystem);

		volume.writeFileSync(
			"/project/pkg/default.project.json",
			JSON.stringify({ name: "pkg-b", tree: { $path: "src" } }),
		);

		await expect(hashOfAsync(fileSystem)).resolves.not.toBe(before);
	});

	it("should change when a file under an absolute mount changes", async () => {
		expect.assertions(1);

		// Rojo mounts an absolute `$path` as written, so the walk reaches it
		// there rather than under the project directory.
		const { fileSystem, volume } = writeProject({
			$className: "DataModel",
			Ext: { $path: "/external/out" },
		});
		volume.mkdirSync("/external/out", { recursive: true });
		volume.writeFileSync("/external/out/a.luau", "local a = 1");
		const before = await hashOfAsync(fileSystem);

		volume.writeFileSync("/external/out/a.luau", "local a = 2");

		await expect(hashOfAsync(fileSystem)).resolves.not.toBe(before);
	});

	it("should exclude mounts that are or are nested under a luauRoot", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = writeProject({
			$className: "DataModel",
			Inc: { $path: "include" },
			Nested: { $path: "out/nested" },
			Out: { $path: "out" },
		});
		volume.mkdirSync("/project/out/nested", { recursive: true });
		volume.writeFileSync("/project/out/a.luau", "local a = 1");
		volume.writeFileSync("/project/out/nested/b.luau", "local b = 1");
		volume.mkdirSync("/project/include", { recursive: true });
		volume.writeFileSync("/project/include/x.lua", "-- x");
		const before = await hashOfAsync(fileSystem, ["out"]);

		volume.writeFileSync("/project/out/a.luau", "local a = 2");
		volume.writeFileSync("/project/out/nested/b.luau", "local b = 2");
		const afterLuauRootEdits = await hashOfAsync(fileSystem, ["out"]);

		volume.writeFileSync("/project/include/x.lua", "-- changed");
		const afterIncludeEdit = await hashOfAsync(fileSystem, ["out"]);

		expect(afterLuauRootEdits).toBe(before);
		expect(afterIncludeEdit).not.toBe(before);
	});

	it("should skip dot-prefixed entries inside a mount", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = writeProject({
			$className: "DataModel",
			Inc: { $path: "include" },
		});
		volume.mkdirSync("/project/include/.cache", { recursive: true });
		volume.writeFileSync("/project/include/.cache/junk", "v1");
		volume.writeFileSync("/project/include/a.lua", "x");
		const before = await hashOfAsync(fileSystem);

		volume.writeFileSync("/project/include/.cache/junk", "v2");

		await expect(hashOfAsync(fileSystem)).resolves.toBe(before);
	});

	it("should drop mounts that do not exist on disk", async () => {
		expect.assertions(1);

		const { fileSystem } = writeProject({ $className: "DataModel", Ghost: { $path: "ghost" } });

		await expect(hashOfAsync(fileSystem)).resolves.toMatch(/^[a-f0-9]{64}$/);
	});

	it("should change when a file is moved with identical content", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = writeProject({
			$className: "DataModel",
			Inc: { $path: "include" },
		});
		volume.mkdirSync("/project/include", { recursive: true });
		volume.writeFileSync("/project/include/a.lua", "same");
		const before = await hashOfAsync(fileSystem);

		volume.unlinkSync("/project/include/a.lua");
		volume.writeFileSync("/project/include/b.lua", "same");

		await expect(hashOfAsync(fileSystem)).resolves.not.toBe(before);
	});

	it("should hash a file reached through a symlinked directory", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = writeProject({
			$className: "DataModel",
			Inc: { $path: "include" },
		});
		volume.mkdirSync("/project/include", { recursive: true });
		volume.mkdirSync("/shared", { recursive: true });
		volume.writeFileSync("/shared/a.lua", "v1");
		volume.symlinkSync("/shared", "/project/include/linked");
		const before = await hashOfAsync(fileSystem);

		volume.writeFileSync("/shared/a.lua", "v2");

		await expect(hashOfAsync(fileSystem)).resolves.not.toBe(before);
	});

	it("should hash a file a mount reaches only by following a symlink", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = writeProject({
			$className: "DataModel",
			Inc: { $path: "linked" },
		});
		volume.mkdirSync("/shared/nested", { recursive: true });
		volume.writeFileSync("/shared/nested/a.lua", "v1");
		volume.mkdirSync("/project", { recursive: true });
		volume.symlinkSync("/shared", "/project/linked");
		const before = await hashOfAsync(fileSystem);

		volume.writeFileSync("/shared/nested/a.lua", "v2");

		await expect(hashOfAsync(fileSystem)).resolves.not.toBe(before);
	});

	it("should terminate on a symlink cycle", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = writeProject({
			$className: "DataModel",
			Inc: { $path: "include" },
		});
		volume.mkdirSync("/project/include", { recursive: true });
		volume.writeFileSync("/project/include/a.lua", "x");
		volume.symlinkSync("/project/include", "/project/include/loop");

		await expect(hashOfAsync(fileSystem)).resolves.toMatch(/^[a-f0-9]{64}$/);
	});

	describe("when the project file has no tree object", () => {
		it("should throw when the project is not a JSON object", async () => {
			expect.assertions(1);

			const { fileSystem } = writeRawProject('"just a string"');

			await expect(hashOfAsync(fileSystem)).rejects.toThrowWithMessage(
				Error,
				/Invalid Rojo project/,
			);
		});

		it("should throw when the project is JSON null", async () => {
			expect.assertions(1);

			const { fileSystem } = writeRawProject("null");

			await expect(hashOfAsync(fileSystem)).rejects.toThrowWithMessage(
				Error,
				/Invalid Rojo project/,
			);
		});

		it("should throw when the project is a JSON array", async () => {
			expect.assertions(1);

			const { fileSystem } = writeRawProject("[]");

			await expect(hashOfAsync(fileSystem)).rejects.toThrowWithMessage(
				Error,
				/Invalid Rojo project/,
			);
		});

		it("should throw when tree is missing", async () => {
			expect.assertions(1);

			const { fileSystem } = writeRawProject('{ "name": "test" }');

			await expect(hashOfAsync(fileSystem)).rejects.toThrowWithMessage(
				Error,
				/Invalid Rojo project/,
			);
		});

		it("should throw when tree is an array", async () => {
			expect.assertions(1);

			const { fileSystem } = writeRawProject('{ "name": "test", "tree": [] }');

			await expect(hashOfAsync(fileSystem)).rejects.toThrowWithMessage(
				Error,
				/Invalid Rojo project/,
			);
		});
	});

	it("should pass over a luauRoot nested inside a mounted directory", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = writeProject({
			$className: "DataModel",
			Out: { $path: "out" },
		});
		volume.mkdirSync("/project/out/modules/ecs", { recursive: true });
		volume.mkdirSync("/project/out/client", { recursive: true });
		volume.writeFileSync("/project/out/modules/ecs/world.luau", "-- v1");
		volume.writeFileSync("/project/out/client/button.luau", "-- v1");
		const before = await hashOfAsync(fileSystem, ["out/modules/ecs"]);

		// The shadow diff content-hashes the root itself, so re-reading it here
		// would double the work the narrowing exists to avoid.
		volume.writeFileSync("/project/out/modules/ecs/world.luau", "-- v2");

		await expect(hashOfAsync(fileSystem, ["out/modules/ecs"])).resolves.toBe(before);

		volume.writeFileSync("/project/out/client/button.luau", "-- v2");

		await expect(hashOfAsync(fileSystem, ["out/modules/ecs"])).resolves.not.toBe(before);
	});
});
