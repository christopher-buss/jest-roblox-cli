import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { makeFileSystem } from "#test/helpers/unit/file-system";
import { walkRojoConfig, walkRojoTree } from "./rojo-walker.ts";

describe(walkRojoConfig, () => {
	it("should skip metadata, nulls and arrays while retaining nested mount siblings", () => {
		expect.assertions(3);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": JSON.stringify({
				name: "Game",
				tree: {
					$className: "DataModel",
					$properties: { Hidden: { $path: "hidden.luau" } },
					Array: [{ $path: "array.luau" }],
					Missing: null,
					Owner: { $path: "nested.project.json", Child: { $path: "child.luau" } },
					Visible$: { $path: "visible.luau" },
				},
			}),
			"invalid.project.json": JSON.stringify({ tree: {} }),
			"nested.project.json": JSON.stringify({
				name: "Ignored",
				tree: { $path: "nested.luau" },
			}),
		});
		const result = walkRojoConfig(path.join(directory, "default.project.json"), fileSystem);

		expect(result.filePathToRbxPathMap).toStrictEqual(
			new Map([
				[path.join(directory, "child.luau"), ["Owner", "Child"]],
				[path.join(directory, "nested.luau"), ["Owner"]],
				[path.join(directory, "visible.luau"), ["Visible$"]],
			]),
		);
		expect(result.warnings).toBeEmpty();
		expect(
			walkRojoConfig(path.join(directory, "invalid.project.json"), fileSystem).warnings,
		).toStrictEqual(["RojoResolver: Invalid configuration!"]);
	});

	it("should report a missing or malformed project without throwing", () => {
		expect.assertions(3);

		const { directory, fileSystem } = makeFileSystem({
			"broken.project.json": "{",
			"invalid.project.json": "{}",
		});

		expect(
			walkRojoConfig(path.join(directory, "missing.project.json"), fileSystem).warnings,
		).toStrictEqual([
			`RojoResolver: Path does not exist "${path.join(directory, "missing.project.json")}"`,
		]);
		expect(
			walkRojoConfig(path.join(directory, "broken.project.json"), fileSystem).warnings,
		).toStrictEqual(["RojoResolver: Invalid configuration!"]);
		expect(
			walkRojoConfig(path.join(directory, "invalid.project.json"), fileSystem)
				.walkedConfigFiles,
		).toStrictEqual(new Set([path.join(directory, "invalid.project.json")]));
	});

	it("should embed file projects and directory defaults without their root names", () => {
		expect.assertions(4);

		const { directory, fileSystem } = makeFileSystem({
			"config.luau": "return 1",
			"default.project.json": JSON.stringify({
				name: "Game",
				tree: {
					$className: "DataModel",
					Directory: { $path: "nested" },
					File: { $path: "inner.project.json" },
					Optional: { $path: { optional: "absent" } },
				},
			}),
			"inner.project.json": JSON.stringify({
				name: "Ignored",
				tree: { $path: "config.luau" },
			}),
			"nested/default.project.json": JSON.stringify({
				name: "Ignored",
				tree: { $path: "source" },
			}),
			"nested/source/value.luau": "return 2",
		});
		const result = walkRojoConfig(path.join(directory, "default.project.json"), fileSystem);

		expect(result.isGame).toBeTrue();
		expect(result.filePathToRbxPathMap).toStrictEqual(
			new Map([[path.join(directory, "config.luau"), ["File"]]]),
		);
		expect(result.partitions).toStrictEqual([
			{ fsPath: path.join(directory, "absent"), rbxPath: ["Optional"] },
			{ fsPath: path.join(directory, "nested/source"), rbxPath: ["Directory"] },
		]);
		expect(result.walkedConfigFiles).toStrictEqual(
			new Set([
				path.join(directory, "default.project.json"),
				path.join(directory, "inner.project.json"),
				path.join(directory, "nested/default.project.json"),
			]),
		);
	});

	it("should visit sibling projects before subdirectories and stop at their defaults", () => {
		expect.assertions(3);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": JSON.stringify({ name: "Game", tree: { $path: "source" } }),
			"source/child/module.luau": "return 1",
			"source/defaulted/default.project.json": JSON.stringify({
				name: "Defaulted",
				tree: { $path: "leaf" },
			}),
			"source/defaulted/leaf/init.luau": "return 2",
			"source/sibling.project.json": JSON.stringify({
				name: "Sibling",
				tree: { $path: "child" },
			}),
		});
		const result = walkRojoConfig(path.join(directory, "default.project.json"), fileSystem);

		expect(result.partitions).toStrictEqual([
			{ fsPath: path.join(directory, "source/defaulted/leaf"), rbxPath: ["Defaulted"] },
			{ fsPath: path.join(directory, "source/child"), rbxPath: ["Sibling"] },
			{ fsPath: path.join(directory, "source"), rbxPath: [] },
		]);
		expect(result.walkedDirectories).toContain(path.join(directory, "source/child"));
		expect(result.warnings).toBeEmpty();
	});

	it("should follow file and directory links and warn about broken links", () => {
		expect.assertions(3);

		const { directory, fileSystem, fs } = makeFileSystem({
			"real.project.json": JSON.stringify({ name: "Linked", tree: { $path: "extra" } }),
			"real/leaf.luau": "return 2",
			"source/module.luau": "return 1",
		});
		fs.symlinkSync(path.join(directory, "real"), path.join(directory, "source/linked"));
		fs.symlinkSync(
			path.join(directory, "real.project.json"),
			path.join(directory, "source/linked.project.json"),
		);
		fs.symlinkSync(path.join(directory, "missing"), path.join(directory, "source/broken"));
		const result = walkRojoTree({ basePath: directory, tree: { $path: "source" } }, fileSystem);

		expect(result.partitions).toContainEqual({
			fsPath: path.join(directory, "source/extra"),
			rbxPath: ["Linked"],
		});
		expect(result.walkedDirectories).toContain(path.join(directory, "real"));
		expect(result.warnings).toStrictEqual([
			expect.stringContaining(`Failed to resolve "${path.join(directory, "source/broken")}"`),
		]);
	});
});

describe(walkRojoTree, () => {
	it("should cache canonical paths and classify native entries without extra stats", () => {
		expect.assertions(3);

		const { directory, fileSystem } = makeFileSystem({ "source/module.luau": "return 1" });
		const realpath = vi.spyOn(fileSystem, "realpathSync");
		const stat = vi.spyOn(fileSystem, "statSync");
		const result = walkRojoTree(
			{
				basePath: directory,
				tree: { First: { $path: "source" }, Second: { $path: "source" } },
			},
			fileSystem,
		);

		expect(realpath).toHaveBeenCalledExactlyOnceWith(path.join(directory, "source"));
		expect(stat).toHaveBeenCalledTimes(2);
		expect(result.walkedDirectories).toStrictEqual(new Set([path.join(directory, "source")]));
	});

	it("should retain directory prefixes and restore the mount path before explicit children", () => {
		expect.assertions(2);

		const { directory, fileSystem } = makeFileSystem({
			"source/folder/a.project.json": JSON.stringify({
				name: "A",
				tree: { $path: "a.luau" },
			}),
			"source/other/b.project.json": JSON.stringify({ name: "B", tree: { $path: "b.luau" } }),
		});
		const result = walkRojoTree(
			{
				basePath: directory,
				tree: {
					Missing: { $path: "missing" },
					Owner: { $path: "source", Child: { $path: "child.luau" } },
				},
			},
			fileSystem,
		);

		expect(result.filePathToRbxPathMap).toStrictEqual(
			new Map([
				[path.join(directory, "child.luau"), ["Owner", "Child"]],
				[path.join(directory, "source/folder/a.luau"), ["Owner", "folder", "A"]],
				[path.join(directory, "source/other/b.luau"), ["Owner", "other", "B"]],
			]),
		);
		expect(result.walkedDirectories).toStrictEqual(
			new Set([
				path.join(directory, "source"),
				path.join(directory, "source/folder"),
				path.join(directory, "source/other"),
			]),
		);
	});

	it("should restore the parent path after each nested child and ignore metadata", () => {
		expect.assertions(2);

		const { directory, fileSystem } = makeFileSystem();
		const result = walkRojoTree(
			{
				basePath: directory,
				tree: {
					$className: "DataModel",
					$properties: [],
					A: { Child: { $path: "a.luau" } },
					B: { $path: "b.json" },
					C: { $path: "missing" },
					Invalid: "skip",
				},
			},
			fileSystem,
		);

		expect(result.filePathToRbxPathMap).toStrictEqual(
			new Map([
				[path.join(directory, "a.luau"), ["A", "Child"]],
				[path.join(directory, "b.json"), ["B"]],
			]),
		);
		expect(result.partitions).toStrictEqual([
			{ fsPath: path.join(directory, "missing"), rbxPath: ["C"] },
		]);
	});
});
