/* eslint-disable unicorn/no-keyword-prefix -- `className` is the Code Bundle's own key, which the Luau rebuild reads by name. */
import * as path from "node:path";
import picomatch from "picomatch";
import { assert, describe, expect, it } from "vitest";

import type { MemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixRoot } from "#test/mocks/posix-path.ts";
import { seed } from "#test/mocks/staged-project.ts";
import { readCodeMount } from "./code-mount.ts";
import type { CodeBundleEntry, MountContents } from "./code-split-types.ts";

const PROJECT_DIR = path.resolve("/cache");
/** The Code Root: where the run's compiled output lives. */
const OUT = path.resolve("/repo/out");

type Read = ReturnType<typeof readCodeMount>;

function read(
	fileSystem: MemoryFileSystem["fileSystem"],
	{ ignore = [], rawPath = OUT }: { ignore?: Array<string>; rawPath?: string } = {},
): Read {
	return readCodeMount(rawPath, {
		codeRoots: [posixRoot(OUT)],
		fileSystem,
		ignored: (absolutePath) => {
			return ignore.length > 0 && picomatch(ignore, { dot: true })(absolutePath);
		},
		projectDirectory: PROJECT_DIR,
	});
}

function contentsOf(result: Read): MountContents {
	assert(result !== undefined && result !== "stays", "expected the mount to travel");
	return result;
}

function entryPaths(result: Read): Array<string> {
	return contentsOf(result).entries.map((entry) => entry.path);
}

function entryAt(result: Read, instancePath: string): CodeBundleEntry {
	return contentsOf(result).entries.find((candidate) => candidate.path === instancePath)!;
}

describe(readCodeMount, () => {
	it("should promote a directory its init file classes", () => {
		expect.assertions(3);

		const { fileSystem } = seed({
			[`${OUT}/init.luau`]: "return 1",
			[`${OUT}/nested/init.server.luau`]: "return 2",
			[`${OUT}/nested/leaf.luau`]: "return 3",
		});

		const result = read(fileSystem);

		expect(contentsOf(result).root).toStrictEqual({
			className: "ModuleScript",
			source: "return 1",
		});
		expect(entryAt(result, "nested")).toStrictEqual({
			className: "Script",
			path: "nested",
			source: "return 2",
		});
		// The promoting file is the directory, never a child beside it.
		expect(entryPaths(result)).toStrictEqual(["nested", "nested/leaf"]);
	});

	it("should carry a json module as a decode of its own text", () => {
		expect.assertions(2);

		const { fileSystem } = seed({ [`${OUT}/preset.json`]: '{"a":1}' });

		const result = read(fileSystem);

		expect(entryAt(result, "preset").className).toBe("ModuleScript");
		expect(entryAt(result, "preset").source).toBe(
			'return game:GetService("HttpService"):JSONDecode([==[{"a":1}]==])',
		);
	});

	it("should promote a directory holding a file rojo builds nothing from", () => {
		expect.assertions(1);

		const { fileSystem } = seed({
			[`${OUT}/init.d.ts`]: "export {};",
			[`${OUT}/init.luau`]: "return 1",
		});

		// The declaration is not an `init` file of any kind, so it neither
		// promotes the directory nor stands beside the one that does.
		expect(read(fileSystem)).toStrictEqual({
			entries: [],
			root: { className: "ModuleScript", source: "return 1" },
		});
	});

	it.for(["blocker.csv", "blocker.model.json", "blocker.rbxmx", "blocker.toml", "blocker.txt"])(
		"should keep a mount holding %s",
		(fileName) => {
			expect.assertions(1);

			// Rojo builds an instance from each of these and no task can
			// construct one, so the mount they sit in has to stay whole.
			const { fileSystem } = seed({
				[`${OUT}/${fileName}`]: "x",
				[`${OUT}/ok.luau`]: "return {}",
			});

			expect(read(fileSystem)).toBe("stays");
		},
	);

	it("should keep a mount holding a descriptor", () => {
		expect.assertions(1);

		const { fileSystem } = seed({
			[`${OUT}/thing.luau`]: "return {}",
			[`${OUT}/thing.meta.json`]: '{"properties":{}}',
		});

		expect(read(fileSystem)).toBe("stays");
	});

	it("should keep a mount holding a nested project", () => {
		expect.assertions(1);

		const { fileSystem } = seed({
			[`${OUT}/inner.project.json`]: '{"name":"inner","tree":{}}',
			[`${OUT}/thing.luau`]: "return {}",
		});

		expect(read(fileSystem)).toBe("stays");
	});

	it("should keep a mount however deep the blocker sits", () => {
		expect.assertions(1);

		const { fileSystem } = seed({
			[`${OUT}/a/b/c/more.csv`]: "1,2",
			[`${OUT}/a/b/notes.txt`]: "hello",
		});

		expect(read(fileSystem)).toBe("stays");
	});

	it("should sort a directory's entries however the host lists them", () => {
		expect.assertions(1);

		const { fileSystem } = seed();

		// Written back to front, which is what a host listing by creation
		// order hands back. The bundle is an artifact, so the same tree has to
		// come out as the same bytes wherever it is read.
		fileSystem.mkdirSync(OUT, { recursive: true });
		for (const name of ["c", "b", "a"]) {
			fileSystem.writeFileSync(`${OUT}/${name}.luau`, `return "${name}"`);
		}

		expect(entryPaths(read(fileSystem))).toStrictEqual(["a", "b", "c"]);
	});

	it("should honour an ignore pattern that reaches a dotfile", () => {
		expect.assertions(1);

		const { fileSystem } = seed({
			[`${OUT}/.notes.txt`]: "hello",
			[`${OUT}/keep.luau`]: "return {}",
		});

		// A leading dot hides a file from an ordinary glob, and a blocker rojo
		// never reads is not what holds a mount back.
		expect(entryPaths(read(fileSystem, { ignore: ["**/*.txt"] }))).toStrictEqual(["keep"]);
	});

	it("should keep a file mount no task can construct", () => {
		expect.assertions(1);

		const { fileSystem } = seed({ [`${OUT}/assets/gui.rbxmx`]: "<roblox/>" });

		expect(read(fileSystem, { rawPath: `${OUT}/assets/gui.rbxmx` })).toBe("stays");
	});

	it("should leave a file the project ignores out of the mount", () => {
		expect.assertions(1);

		const { fileSystem } = seed({
			[`${OUT}/keep.luau`]: "return {}",
			[`${OUT}/skip.rbxm`]: "binary",
		});

		// Ignored, so rojo builds nothing from it — and a blocker rojo never
		// reads cannot be what holds the mount back.
		expect(entryPaths(read(fileSystem, { ignore: ["**/skip.rbxm"] }))).toStrictEqual(["keep"]);
	});
});
