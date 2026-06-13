import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { computeRojoInputsHash } from "./rojo-inputs.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

const PROJECT = "/project/default.project.json";

function reset(): void {
	onTestFinished(() => {
		vol.reset();
	});
}

function writeProject(tree: unknown): void {
	vol.mkdirSync("/project", { recursive: true });
	vol.writeFileSync(PROJECT, JSON.stringify({ name: "test", tree }));
}

function hashOf(luauRoots: Array<string> = []): string {
	return computeRojoInputsHash({
		luauRoots,
		rojoProjectPath: PROJECT,
		rootDirectory: "/project",
	});
}

describe(computeRojoInputsHash, () => {
	it("should return a sha256 digest", () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel" });

		expect(hashOf()).toMatch(/^[a-f0-9]{64}$/);
	});

	it("should be stable when nothing changes", () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Inc: { $path: "include" } });
		vol.mkdirSync("/project/include", { recursive: true });
		vol.writeFileSync("/project/include/RuntimeLib.lua", "-- v1");

		expect(hashOf()).toBe(hashOf());
	});

	it("should change when a mounted directory's file content changes", () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Inc: { $path: "include" } });
		vol.mkdirSync("/project/include", { recursive: true });
		vol.writeFileSync("/project/include/RuntimeLib.lua", "-- v1");
		const before = hashOf();

		vol.writeFileSync("/project/include/RuntimeLib.lua", "-- v2");

		expect(hashOf()).not.toBe(before);
	});

	it("should change when a directly mounted file changes", () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Lib: { $path: "include/RuntimeLib.lua" } });
		vol.mkdirSync("/project/include", { recursive: true });
		vol.writeFileSync("/project/include/RuntimeLib.lua", "-- v1");
		const before = hashOf();

		vol.writeFileSync("/project/include/RuntimeLib.lua", "-- v2");

		expect(hashOf()).not.toBe(before);
	});

	it("should change when the rojo project file itself changes", () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel" });
		const before = hashOf();

		writeProject({ $className: "DataModel", $ignoreUnknownInstances: true });

		expect(hashOf()).not.toBe(before);
	});

	it("should change when an inlined nested project file changes", () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Pkg: { $path: "pkg" } });
		vol.mkdirSync("/project/pkg", { recursive: true });
		vol.writeFileSync(
			"/project/pkg/default.project.json",
			JSON.stringify({ name: "pkg-a", tree: { $path: "src" } }),
		);
		vol.mkdirSync("/project/pkg/src", { recursive: true });
		const before = hashOf();

		vol.writeFileSync(
			"/project/pkg/default.project.json",
			JSON.stringify({ name: "pkg-b", tree: { $path: "src" } }),
		);

		expect(hashOf()).not.toBe(before);
	});

	it("should exclude mounts that are or are nested under a luauRoot", () => {
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
		const before = hashOf(["out"]);

		vol.writeFileSync("/project/out/a.luau", "local a = 2");
		vol.writeFileSync("/project/out/nested/b.luau", "local b = 2");
		const afterLuauRootEdits = hashOf(["out"]);

		vol.writeFileSync("/project/include/x.lua", "-- changed");
		const afterIncludeEdit = hashOf(["out"]);

		expect(afterLuauRootEdits).toBe(before);
		expect(afterIncludeEdit).not.toBe(before);
	});

	it("should skip dot-prefixed entries inside a mount", () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Inc: { $path: "include" } });
		vol.mkdirSync("/project/include/.cache", { recursive: true });
		vol.writeFileSync("/project/include/.cache/junk", "v1");
		vol.writeFileSync("/project/include/a.lua", "x");
		const before = hashOf();

		vol.writeFileSync("/project/include/.cache/junk", "v2");

		expect(hashOf()).toBe(before);
	});

	it("should drop mounts that do not exist on disk", () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Ghost: { $path: "ghost" } });

		expect(hashOf()).toMatch(/^[a-f0-9]{64}$/);
	});

	it("should change when a file is moved with identical content", () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Inc: { $path: "include" } });
		vol.mkdirSync("/project/include", { recursive: true });
		vol.writeFileSync("/project/include/a.lua", "same");
		const before = hashOf();

		vol.unlinkSync("/project/include/a.lua");
		vol.writeFileSync("/project/include/b.lua", "same");

		expect(hashOf()).not.toBe(before);
	});

	it("should terminate on a symlink cycle", () => {
		expect.assertions(1);

		reset();
		writeProject({ $className: "DataModel", Inc: { $path: "include" } });
		vol.mkdirSync("/project/include", { recursive: true });
		vol.writeFileSync("/project/include/a.lua", "x");
		vol.symlinkSync("/project/include", "/project/include/loop");

		expect(hashOf()).toMatch(/^[a-f0-9]{64}$/);
	});
});
