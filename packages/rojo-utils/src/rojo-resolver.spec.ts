import { fromAny } from "@total-typescript/shoehorn";

import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { makeFileSystem } from "#test/helpers/unit/file-system";
import type { FileSystem } from "./file-system.ts";
import { FileRelation, NetworkType, RbxType, RojoResolver } from "./rojo-resolver.ts";
import type { RojoResolverState } from "./rojo-resolver.ts";
import type { RojoTree } from "./rojo-walker.ts";

function project(tree: RojoTree, name = "Game"): string {
	return JSON.stringify({ name, tree });
}

function fromProject({
	directory,
	fileSystem,
}: {
	directory: string;
	fileSystem: FileSystem;
}): RojoResolver {
	return RojoResolver.fromPath(path.join(directory, "default.project.json"), fileSystem);
}

function makeModuleProject(): ReturnType<typeof makeFileSystem> {
	return makeFileSystem({
		"default.project.json": project({
			$className: "DataModel",
			ReplicatedStorage: { $path: "src/shared" },
		}),
		"src/shared/init.luau": "return {}",
		"src/shared/module.luau": "return {}",
	});
}

function makeSyntheticFileSystem(): ReturnType<typeof makeFileSystem> {
	const fixture = makeFileSystem();
	const { fromTree } = RojoResolver;
	const spy = vi.spyOn(RojoResolver, "fromTree").mockImplementation((options) => {
		return fromTree(options, fixture.fileSystem);
	});
	onTestFinished(() => {
		spy.mockRestore();
	});
	return fixture;
}

describe("findRojoConfigFilePath", () => {
	it("should prefer the default project over sorted alternatives", () => {
		expect.assertions(2);

		const { directory, fileSystem } = makeFileSystem({
			"a.project.json": "{}",
			"default.project.json": "{}",
			"z.project.json": "{}",
		});
		const result = RojoResolver.findRojoConfigFilePath(directory, fileSystem);

		expect(result.path).toBe(path.join(directory, "default.project.json"));
		expect(result.warnings).toBeEmpty();
	});

	it("should default an empty resolver to non-game queries", () => {
		expect.assertions(2);

		const resolver = new RojoResolver();

		expect(resolver.isGame).toBeFalse();
		expect(resolver.getNetworkType(["StarterGui"])).toBe(NetworkType.Unknown);
	});

	it("should return the default project file when present", () => {
		expect.assertions(2);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": project({ $className: "DataModel" }),
		});
		const result = RojoResolver.findRojoConfigFilePath(directory, fileSystem);

		expect(result.path).toBe(path.join(directory, "default.project.json"));
		expect(result.warnings).toBeEmpty();
	});

	it("should return a single non-default project file without warning", () => {
		expect.assertions(2);

		const { directory, fileSystem } = makeFileSystem({
			"game.project.json": project({ $className: "DataModel" }),
		});
		const result = RojoResolver.findRojoConfigFilePath(directory, fileSystem);

		expect(result.path).toBe(path.join(directory, "game.project.json"));
		expect(result.warnings).toBeEmpty();
	});

	it("should skip a dangling default project link", () => {
		expect.assertions(2);

		const { directory, fileSystem, fs } = makeFileSystem({
			"game.project.json": project({ $className: "DataModel" }),
		});
		fs.symlinkSync(
			path.join(directory, "missing.json"),
			path.join(directory, "default.project.json"),
		);
		const result = RojoResolver.findRojoConfigFilePath(directory, fileSystem);

		expect(result.path).toBe(path.join(directory, "game.project.json"));
		expect(result.warnings).toBeEmpty();
	});

	it("should recognize the legacy roblox-project.json name", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({
			"roblox-project.json": project({ $className: "DataModel" }),
		});

		expect(RojoResolver.findRojoConfigFilePath(directory, fileSystem).path).toBe(
			path.join(directory, "roblox-project.json"),
		);
	});

	it("should warn when multiple project files are present", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({
			"a.project.json": project({ $className: "DataModel" }),
			"b.project.json": project({ $className: "DataModel" }),
		});

		expect(RojoResolver.findRojoConfigFilePath(directory, fileSystem).warnings[0]).toInclude(
			"Multiple *.project.json files found",
		);
	});

	it("should probe the given file system rather than the disk", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({ "default.project.json": "{}" });

		expect(RojoResolver.findRojoConfigFilePath(directory, fileSystem).path).toBe(
			path.join(directory, "default.project.json"),
		);
	});

	it("should return undefined when no project file is present", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({ "readme.md": "hi" });

		expect(RojoResolver.findRojoConfigFilePath(directory, fileSystem).path).toBeUndefined();
	});
});

describe("fromPath", () => {
	it("should mark a DataModel project as a game", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": project({ $className: "DataModel" }),
		});

		expect(fromProject({ directory, fileSystem }).isGame).toBeTrue();
	});

	it("should warn when the config path does not exist", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({ "readme.md": "hi" });

		const resolver = RojoResolver.fromPath(
			path.join(directory, "default.project.json"),
			fileSystem,
		);

		expect(resolver.getWarnings()[0]).toInclude("Path does not exist");
	});

	it("should warn on an invalid configuration", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": JSON.stringify({ notName: 1 }),
		});

		expect(fromProject({ directory, fileSystem }).getWarnings()[0]).toInclude(
			"Invalid configuration",
		);
	});

	it("should warn when the tree is an array rather than an object", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": JSON.stringify({ name: "Game", tree: [] }),
		});

		expect(fromProject({ directory, fileSystem }).getWarnings()[0]).toInclude(
			"Invalid configuration",
		);
	});

	it("should warn when $path is neither a string nor an optional mount", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": JSON.stringify({ name: "Game", tree: { $path: 42 } }),
		});

		expect(fromProject({ directory, fileSystem }).getWarnings()[0]).toInclude(
			"Invalid configuration",
		);
	});

	it("should warn on malformed JSON instead of throwing", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": "{ broken json",
		});

		expect(fromProject({ directory, fileSystem }).getWarnings()[0]).toInclude(
			"Invalid configuration",
		);
	});

	it("should map a module file path directly", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({
			"config.luau": "return {}",
			"default.project.json": project({
				$className: "DataModel",
				Config: { $path: "config.luau" },
			}),
		});

		expect(
			fromProject({ directory, fileSystem }).getRbxPathFromFilePath(
				path.join(directory, "config.luau"),
			),
		).toStrictEqual(["Config"]);
	});

	it("should resolve a directory partition and strip init", () => {
		expect.assertions(2);

		const { directory, fileSystem } = makeModuleProject();

		const resolver = fromProject({ directory, fileSystem });

		expect(
			resolver.getRbxPathFromFilePath(path.join(directory, "src/shared/init.luau")),
		).toStrictEqual(["ReplicatedStorage"]);
		expect(
			resolver.getRbxPathFromFilePath(path.join(directory, "src/shared/module.luau")),
		).toStrictEqual(["ReplicatedStorage", "module"]);
	});

	it("should accept the optional $path object form", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": project({
				$className: "DataModel",
				Maybe: { $path: { optional: "src/maybe" } },
			}),
			"src/maybe/value.luau": "return {}",
		});

		expect(
			fromProject({ directory, fileSystem }).getRbxPathFromFilePath(
				path.join(directory, "src/maybe/value.luau"),
			),
		).toStrictEqual(["Maybe", "value"]);
	});

	it("should create a partition for a $path that does not exist", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": project({
				$className: "DataModel",
				Ghost: { $path: "does/not/exist" },
			}),
		});

		expect(fromProject({ directory, fileSystem }).getPartitions()).not.toBeEmpty();
	});

	it("should parse a nested default project referenced by directory", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": project({
				$className: "DataModel",
				Nested: { $path: "nested" },
			}),
			"nested/default.project.json": project({ $path: "src" }, "Nested"),
			"nested/src/inside.luau": "return {}",
		});

		expect(
			fromProject({ directory, fileSystem }).getRbxPathFromFilePath(
				path.join(directory, "nested/src/inside.luau"),
			),
		).toStrictEqual(["Nested", "inside"]);
	});

	it("should embed a nested project referenced by a project file and ignore its name", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": project({
				$className: "DataModel",
				Pkg: { $path: "shared.project.json" },
			}),
			"shared.project.json": project({ $path: "src" }, "IgnoredName"),
			"src/mod.luau": "return {}",
		});

		// Mounts under the parent key "Pkg", not the nested project's own
		// name "IgnoredName".
		expect(
			fromProject({ directory, fileSystem }).getRbxPathFromFilePath(
				path.join(directory, "src/mod.luau"),
			),
		).toStrictEqual(["Pkg", "mod"]);
	});

	it("should register the nested partition and not map the project file as a leaf", () => {
		expect.assertions(3);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": project({
				$className: "DataModel",
				Pkg: { $path: "shared.project.json" },
			}),
			"shared.project.json": project({ $path: "src" }, "Pkg"),
			"src/mod.luau": "return {}",
		});

		const resolver = fromProject({ directory, fileSystem });
		const state = resolver.getState();
		const projectFile = path.join(directory, "shared.project.json");

		expect(state.partitions.some((partition) => partition.fsPath.endsWith("src"))).toBeTrue();
		expect(
			state.filePathToRbxPathMap.some(([filePath]) => filePath === projectFile),
		).toBeFalse();
		// The nested project file is walked, so cache invalidation tracks
		// edits to it (RojoResolverCache keys on walkedConfigFiles).
		expect([...resolver.walkedConfigFiles]).toContain(projectFile);
	});

	it("should return undefined for an unmapped file", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": project({ $className: "DataModel" }),
		});

		expect(
			fromProject({ directory, fileSystem }).getRbxPathFromFilePath(
				path.join(directory, "elsewhere.luau"),
			),
		).toBeUndefined();
	});
});

describe("searchDirectory", () => {
	it("should follow nested project files and subfolders", () => {
		expect.assertions(2);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": project({
				$className: "DataModel",
				ReplicatedStorage: { $path: "src/shared" },
			}),
			"extra/leaf.luau": "return {}",
			"src/shared/extra.project.json": project({ $path: "../../extra" }, "Extra"),
			"src/shared/sub/leaf.luau": "return {}",
		});

		const resolver = fromProject({ directory, fileSystem });

		expect(
			resolver.getRbxPathFromFilePath(path.join(directory, "src/shared/sub/leaf.luau")),
		).toStrictEqual(["ReplicatedStorage", "sub", "leaf"]);
		expect(resolver.getPartitions().length).toBeGreaterThan(1);
	});

	it("should stop at a subfolder that has its own default project", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": project({
				$className: "DataModel",
				ReplicatedStorage: { $path: "src/shared" },
			}),
			"src/shared/module.luau": "return {}",
			"src/shared/withDefault/default.project.json": project(
				{ $path: "../module.luau" },
				"Inner",
			),
		});

		expect(fromProject({ directory, fileSystem }).isGame).toBeTrue();
	});
});

describe("getRbxTypeFromFilePath", () => {
	it("should classify non-script side suffixes as modules", () => {
		expect.assertions(1);

		const resolver = new RojoResolver();

		expect(resolver.getRbxTypeFromFilePath("value.server.json")).toBe(RbxType.ModuleScript);
	});

	it("should classify a .server script", () => {
		expect.assertions(1);

		const resolver = new RojoResolver();

		expect(resolver.getRbxTypeFromFilePath("a.server.luau")).toBe(RbxType.Script);
	});

	it("should classify a .client script", () => {
		expect.assertions(1);

		const resolver = new RojoResolver();

		expect(resolver.getRbxTypeFromFilePath("a.client.luau")).toBe(RbxType.LocalScript);
	});

	it("should classify a plain module script", () => {
		expect.assertions(1);

		const resolver = new RojoResolver();

		expect(resolver.getRbxTypeFromFilePath("a.luau")).toBe(RbxType.ModuleScript);
	});

	it("should classify a non-script module by extension", () => {
		expect.assertions(1);

		const resolver = new RojoResolver();

		expect(resolver.getRbxTypeFromFilePath("a.json")).toBe(RbxType.ModuleScript);
	});

	it("should return Unknown for an unrecognized sub-extension", () => {
		expect.assertions(1);

		const resolver = new RojoResolver();

		expect(resolver.getRbxTypeFromFilePath("a.weird.luau")).toBe(RbxType.Unknown);
	});

	it("should convert a .lua extension to .luau", () => {
		expect.assertions(1);

		const resolver = new RojoResolver();

		expect(resolver.getRbxTypeFromFilePath("a.lua")).toBe(RbxType.ModuleScript);
	});
});

describe("container queries", () => {
	function gameResolver({
		directory,
		fileSystem,
		fs,
	}: ReturnType<typeof makeFileSystem>): RojoResolver {
		fs.writeFileSync(
			path.join(directory, "default.project.json"),
			project({
				$className: "DataModel",
				ServerScriptService: { $path: "src/server" },
				StarterGui: { $path: "src/gui" },
				StarterPack: { $path: "src/pack" },
			}),
		);
		for (const relativePath of ["src/server/a.luau", "src/gui/b.luau", "src/pack/c.luau"]) {
			const full = path.join(directory, relativePath);
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, "return {}");
		}

		return fromProject({ directory, fileSystem });
	}

	it("should report network type by container", () => {
		expect.assertions(3);

		const { directory, fileSystem, fs } = makeFileSystem({});
		const resolver = gameResolver({ directory, fileSystem, fs });

		expect(resolver.getNetworkType(["ServerScriptService"])).toBe(NetworkType.Server);
		expect(resolver.getNetworkType(["StarterGui"])).toBe(NetworkType.Client);
		expect(resolver.getNetworkType(["ReplicatedStorage"])).toBe(NetworkType.Unknown);
	});

	it("should detect isolated containers", () => {
		expect.assertions(2);

		const { directory, fileSystem, fs } = makeFileSystem({});

		const resolver = gameResolver({ directory, fileSystem, fs });

		expect(resolver.isIsolated(["StarterGui"])).toBeTrue();
		expect(resolver.isIsolated(["ReplicatedStorage"])).toBeFalse();
	});

	it("should compute file relations across containers", () => {
		expect.assertions(5);

		const { directory, fileSystem, fs } = makeFileSystem({});
		const resolver = gameResolver({ directory, fileSystem, fs });

		expect(resolver.getFileRelation(["StarterGui", "a"], ["StarterGui", "b"])).toBe(
			FileRelation.InToIn,
		);
		expect(resolver.getFileRelation(["StarterGui"], ["StarterPack"])).toBe(
			FileRelation.OutToIn,
		);
		expect(resolver.getFileRelation(["StarterGui"], ["ReplicatedStorage"])).toBe(
			FileRelation.InToOut,
		);
		expect(resolver.getFileRelation(["ReplicatedStorage"], ["StarterGui"])).toBe(
			FileRelation.OutToIn,
		);
		expect(resolver.getFileRelation(["ReplicatedStorage"], ["Workspace"])).toBe(
			FileRelation.OutToOut,
		);
	});

	it("should treat a synthetic non-game resolver as all-out", () => {
		expect.assertions(3);

		const { directory } = makeSyntheticFileSystem();
		const resolver = RojoResolver.synthetic(directory);

		expect(resolver.getNetworkType(["StarterGui"])).toBe(NetworkType.Unknown);
		expect(resolver.isIsolated(["StarterGui"])).toBeFalse();
		expect(resolver.getFileRelation(["StarterGui"], ["StarterGui"])).toBe(
			FileRelation.OutToOut,
		);
	});
});

describe("relative", () => {
	it("should return an empty path for identical locations", () => {
		expect.assertions(1);

		expect(RojoResolver.relative(["a", "b"], ["a", "b"])).toBeEmpty();
	});

	it("should descend into a child path", () => {
		expect.assertions(1);

		expect(RojoResolver.relative(["a"], ["a", "b", "c"])).toStrictEqual(["b", "c"]);
	});

	it("should ascend with parent markers", () => {
		expect.assertions(1);

		expect(RojoResolver.relative(["a", "b", "c"], ["a"])).toStrictEqual([
			RojoResolver.relative(["child"], [])[0]!,
			RojoResolver.relative(["child"], [])[0]!,
		]);
	});

	it("should mix ascent and descent", () => {
		expect.assertions(1);

		expect(RojoResolver.relative(["a", "b"], ["a", "c"])).toStrictEqual([
			RojoResolver.relative(["child"], [])[0]!,
			"c",
		]);
	});
});

describe("state serialization", () => {
	it("should copy nested snapshot collections in both directions", () => {
		expect.assertions(2);

		const original = {
			filePathToRbxPathMap: [[path.resolve("source.luau"), ["Module"]]],
			isGame: true,
			isolatedContainers: [["StarterGui"]],
			partitions: [{ fsPath: path.resolve("source"), rbxPath: ["Shared"] }],
			walkedConfigFiles: ["project"],
			walkedDirs: ["source"],
			warnings: ["warning"],
		} satisfies RojoResolverState;
		const snapshot = structuredClone(original);
		const resolver = RojoResolver.fromState(original);
		original.filePathToRbxPathMap[0]![1].push("changed");
		original.isolatedContainers[0]!.push("changed");
		original.partitions[0]!.rbxPath.push("changed");
		original.warnings.push("changed");

		expect(resolver.getState()).toStrictEqual(snapshot);

		const exported = resolver.getState();
		const filePath: Array<string> = fromAny(exported.filePathToRbxPathMap[0]![1]);
		const isolatedPath: Array<string> = fromAny(exported.isolatedContainers[0]!);
		const partitionPath: Array<string> = fromAny(exported.partitions[0]!.rbxPath);
		filePath[0] = "changed";
		isolatedPath[0] = "changed";
		partitionPath[0] = "changed";
		exported.warnings.push("changed");

		expect(resolver.getState()).toStrictEqual(snapshot);
	});

	it("should round-trip through getState and fromState", () => {
		expect.assertions(4);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": project({
				$className: "DataModel",
				ReplicatedStorage: { $path: "src/shared" },
			}),
			"src/shared/module.luau": "return {}",
		});

		const original = fromProject({ directory, fileSystem });
		const restored = RojoResolver.fromState(original.getState());
		const modulePath = path.join(directory, "src/shared/module.luau");

		expect(restored.isGame).toBe(original.isGame);
		expect(restored.getRbxPathFromFilePath(modulePath)).toStrictEqual(
			original.getRbxPathFromFilePath(modulePath),
		);
		expect(restored.walkedConfigFiles.size).toBe(original.walkedConfigFiles.size);
		expect(restored.walkedDirectories.size).toBe(original.walkedDirectories.size);
	});

	it("should record walked directories and config files", () => {
		expect.assertions(2);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": project({
				$className: "DataModel",
				ReplicatedStorage: { $path: "src/shared" },
			}),
			"src/shared/module.luau": "return {}",
		});
		const resolver = fromProject({ directory, fileSystem });

		expect(resolver.walkedConfigFiles.size).toBeGreaterThan(0);
		expect(resolver.walkedDirectories.size).toBeGreaterThan(0);
	});

	it("should round-trip a direct module-file mapping", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({
			"config.luau": "return {}",
			"default.project.json": project({
				$className: "DataModel",
				Config: { $path: "config.luau" },
			}),
		});
		const original = fromProject({ directory, fileSystem });
		const restored = RojoResolver.fromState(original.getState());
		const configPath = path.join(directory, "config.luau");

		expect(restored.getRbxPathFromFilePath(configPath)).toStrictEqual(
			original.getRbxPathFromFilePath(configPath),
		);
	});
});

describe("non-module file partitions", () => {
	it("should mount synthetic source roots", () => {
		expect.assertions(1);

		const { directory } = makeSyntheticFileSystem();
		const resolver = RojoResolver.synthetic(directory);

		expect(resolver.getRbxPathFromFilePath(path.join(directory, "leaf.luau"))).toStrictEqual([
			"leaf",
		]);
	});

	it("should resolve a partition that targets a non-module file", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({
			"data.txt": "hello",
			"default.project.json": project({
				$className: "DataModel",
				Data: { $path: "data.txt" },
			}),
		});

		expect(
			fromProject({ directory, fileSystem }).getRbxPathFromFilePath(
				path.join(directory, "data.txt"),
			),
		).toStrictEqual(["Data"]);
	});

	it("should resolve a non-script module extension under a partition", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": project({
				$className: "DataModel",
				ReplicatedStorage: { $path: "src/shared" },
			}),
			"src/shared/data.json": "{}",
		});

		expect(
			fromProject({ directory, fileSystem }).getRbxPathFromFilePath(
				path.join(directory, "src/shared/data.json"),
			),
		).toStrictEqual(["ReplicatedStorage", "data"]);
	});
});

describe("script sub-extension resolution", () => {
	it("should strip a .server sub-extension when resolving via a partition", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({
			"default.project.json": project({
				$className: "DataModel",
				ServerScriptService: { $path: "src/server" },
			}),
			"src/server/main.server.luau": "return {}",
		});

		expect(
			fromProject({ directory, fileSystem }).getRbxPathFromFilePath(
				path.join(directory, "src/server/main.server.luau"),
			),
		).toStrictEqual(["ServerScriptService", "main"]);
	});
});

describe("walker parity snapshot", () => {
	function snapshot(state: ReturnType<RojoResolver["getState"]>, root: string) {
		function strip(full: string): string {
			return full.replaceAll(root, "<root>").replaceAll("\\", "/");
		}

		return {
			// Partitions order matters: parseConfig/parsePath unshift, and
			// getRbxPathFromFilePath returns the first descendant match. Don't
			// sort.
			filePathToRbxPathMap: state.filePathToRbxPathMap.map(([file, rbxPath]) => [
				strip(file),
				rbxPath,
			]),
			isGame: state.isGame,
			partitions: state.partitions.map((partition) => {
				return { fsPath: strip(partition.fsPath), rbxPath: partition.rbxPath };
			}),
			// walkedConfigFiles / walkedDirs come from Sets used only for cache
			// invalidation; sort for stability across traversal-order changes.
			walkedConfigFiles: state.walkedConfigFiles.map(strip).toSorted(),
			walkedDirs: state.walkedDirs.map(strip).toSorted(),
			warnings: state.warnings,
		};
	}

	it("should capture combined partition / nested / overlap / init shapes", () => {
		// One synth tree exercising the interactions the isolated tests miss:
		// a sibling *.project.json next to a sibling directory both contributing
		// partitions, a nested default.project.json reached via $path, init
		// stripping, and a direct module-file mapping. The snapshot pins the
		// resolver-state shape; the trailing expectations back the comment's
		// claim by asserting init/module resolve via the partition fallback.
		expect.assertions(3);

		const { directory, fileSystem } = makeFileSystem({
			"config.luau": "return {}",
			"default.project.json": project({
				$className: "DataModel",
				Direct: { $path: "config.luau" },
				Nested: { $path: "nested" },
				ReplicatedStorage: { $path: "src/shared" },
			}),
			"nested/default.project.json": project({ $path: "src" }, "Nested"),
			"nested/src/inside.luau": "return {}",
			"src/shared/child.project.json": project({ $path: "child" }, "ChildViaProject"),
			"src/shared/child/leaf.luau": "return {}",
			"src/shared/init.luau": "return {}",
			"src/shared/module.luau": "return {}",
		});
		const resolver = fromProject({ directory, fileSystem });

		expect(
			resolver.getRbxPathFromFilePath(path.join(directory, "src/shared/init.luau")),
		).toStrictEqual(["ReplicatedStorage"]);
		expect(
			resolver.getRbxPathFromFilePath(path.join(directory, "src/shared/module.luau")),
		).toStrictEqual(["ReplicatedStorage", "module"]);
		expect(snapshot(resolver.getState(), directory)).toMatchInlineSnapshot(`
					{
					  "filePathToRbxPathMap": [
					    [
					      "<root>/config.luau",
					      [
					        "Direct",
					      ],
					    ],
					  ],
					  "isGame": true,
					  "partitions": [
					    {
					      "fsPath": "<root>/src/shared/child",
					      "rbxPath": [
					        "ReplicatedStorage",
					        "ChildViaProject",
					      ],
					    },
					    {
					      "fsPath": "<root>/src/shared",
					      "rbxPath": [
					        "ReplicatedStorage",
					      ],
					    },
					    {
					      "fsPath": "<root>/nested/src",
					      "rbxPath": [
					        "Nested",
					      ],
					    },
					  ],
					  "walkedConfigFiles": [
					    "<root>/default.project.json",
					    "<root>/nested/default.project.json",
					    "<root>/src/shared/child.project.json",
					  ],
					  "walkedDirs": [
					    "<root>/nested",
					    "<root>/nested/src",
					    "<root>/src/shared",
					    "<root>/src/shared/child",
					  ],
					  "warnings": [],
					}
				`);
	});
});

describe("fromTree", () => {
	it("should build a resolver from a tree object", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({ "src/value.luau": "return {}" });

		const resolver = RojoResolver.fromTree(
			{
				basePath: directory,
				tree: {
					$className: "DataModel",
					Shared: { $path: "src" },
				},
			},
			fileSystem,
		);

		expect(
			resolver.getRbxPathFromFilePath(path.join(directory, "src/value.luau")),
		).toStrictEqual(["Shared", "value"]);
	});

	it("should skip members that are not trees", () => {
		expect.assertions(1);

		const { directory, fileSystem } = makeFileSystem({ "src/value.luau": "return {}" });

		const resolver = RojoResolver.fromTree(
			{
				basePath: directory,
				tree: {
					$className: "DataModel",
					Bogus: "not-a-tree",
					Shared: { $path: "src" },
				},
			},
			fileSystem,
		);

		expect(resolver.getPartitions()).toHaveLength(1);
	});
});
