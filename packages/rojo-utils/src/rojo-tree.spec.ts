import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { captureError } from "#test/helpers/unit/errors";
import { makeFileSystem } from "#test/helpers/unit/file-system";
import { resolveNestedProjects, resolveNestedProjectSources } from "./rojo-tree.ts";
import type { RojoTreeNode } from "./rojo-types.ts";

function makeNestedDirectoryProject(): ReturnType<typeof makeFileSystem> {
	return makeFileSystem({
		"pkg/default.project.json": JSON.stringify({ name: "pkg", tree: { $path: "src" } }),
	});
}

describe(resolveNestedProjects, () => {
	it("should preserve metadata while resolving optional-looking child nodes", () => {
		expect.assertions(1);

		const tree = {
			$properties: { Hidden: { $path: "missing.project.json" } },
			Child$: { Leaf: { $path: "inner.project.json" }, optional: "ordinary-field" },
		};
		const { directory, fileSystem } = makeFileSystem({
			"inner.project.json": JSON.stringify({ tree: { $path: "visible" } }),
		});

		expect(resolveNestedProjects({ rootDirectory: directory, tree }, fileSystem)).toStrictEqual(
			{
				$properties: tree.$properties,
				Child$: { Leaf: { $path: "visible" }, optional: "ordinary-field" },
			},
		);
	});

	it("should preserve read and parse failures on nested project errors", () => {
		expect.assertions(3);

		const { directory, fileSystem, fs } = makeFileSystem({
			"array.project.json": JSON.stringify({ tree: [] }),
			"broken.project.json": "{",
		});

		expect(() => {
			return resolveNestedProjects(
				{ rootDirectory: directory, tree: { $path: "array.project.json" } },
				fileSystem,
			);
		}).toThrow(
			expect.objectContaining({
				cause: expect.objectContaining({
					message: "tree must be an object (was an array)",
				}),
			}),
		);

		const parseError = captureError(() => {
			resolveNestedProjects(
				{ rootDirectory: directory, tree: { $path: "broken.project.json" } },
				fileSystem,
			);
		});

		fs.rmSync(path.join(directory, "array.project.json"));

		const readError = captureError(() => {
			resolveNestedProjects(
				{ rootDirectory: directory, tree: { $path: "array.project.json" } },
				fileSystem,
			);
		});

		expect(parseError.cause).toBeInstanceOf(SyntaxError);
		expect(readError.cause).toBeInstanceOf(Error);
	});

	it("should return tree unchanged when no $path references .project.json", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				client: { $path: "out/client" },
			},
		};

		const { directory: temporaryDirectory, fileSystem } = makeFileSystem();
		const result = resolveNestedProjects(
			{ rootDirectory: temporaryDirectory, tree },
			fileSystem,
		);

		expect(result).toStrictEqual(tree);
	});

	it("should resolve $path pointing to a .project.json into its inner tree's $path", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();
		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify({ name: "my-pkg", tree: { $path: "src" } }),
		);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				"my-pkg": { $path: "default.project.json" },
			},
		};

		const result = resolveNestedProjects(
			{ rootDirectory: temporaryDirectory, tree },
			fileSystem,
		);

		expect(result).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				"my-pkg": { $path: "src" },
			},
		});
	});

	it("should merge children from the nested project's tree into the node", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();
		fs.writeFileSync(
			path.join(temporaryDirectory, "shared.project.json"),
			JSON.stringify({
				name: "Shared",
				tree: {
					$className: "Folder",
					Components: { $className: "Folder", $path: "src/Shared/Components" },
					Utils: { $className: "Folder", $path: "src/Shared/Utils" },
				},
			}),
		);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				Shared: { $path: "shared.project.json" },
			},
		};

		const result = resolveNestedProjects(
			{ rootDirectory: temporaryDirectory, tree },
			fileSystem,
		);

		expect(result).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				Shared: {
					$className: "Folder",
					Components: { $className: "Folder", $path: "src/Shared/Components" },
					Utils: { $className: "Folder", $path: "src/Shared/Utils" },
				},
			},
		});
	});

	it("should resolve chained project references recursively", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();
		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify({ name: "uuid-generator", tree: { $path: "src" } }),
		);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				"uuid-generator": { $path: "default.project.json" },
			},
		};

		const result = resolveNestedProjects(
			{ rootDirectory: temporaryDirectory, tree },
			fileSystem,
		);

		expect(result).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				"uuid-generator": { $path: "src" },
			},
		});
	});

	it("should throw with file path when nested project has malformed JSON", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();
		fs.writeFileSync(path.join(temporaryDirectory, "bad.project.json"), "not valid json {{{");

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				bad: { $path: "bad.project.json" },
			},
		};

		expect(() => {
			return resolveNestedProjects({ rootDirectory: temporaryDirectory, tree }, fileSystem);
		}).toThrow("bad.project.json");
	});

	it("should throw with file path when a nested project has no tree", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();
		fs.writeFileSync(
			path.join(temporaryDirectory, "treeless.project.json"),
			'{ "name": "treeless" }',
		);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				treeless: { $path: "treeless.project.json" },
			},
		};

		expect(() => {
			return resolveNestedProjects({ rootDirectory: temporaryDirectory, tree }, fileSystem);
		}).toThrow("Failed to parse nested Rojo project: treeless.project.json");
	});

	it("should throw with file path when a nested project's tree is an array", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();
		fs.writeFileSync(
			path.join(temporaryDirectory, "array.project.json"),
			'{ "name": "array", "tree": [] }',
		);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				array: { $path: "array.project.json" },
			},
		};

		expect(() => {
			return resolveNestedProjects({ rootDirectory: temporaryDirectory, tree }, fileSystem);
		}).toThrow("Failed to parse nested Rojo project: array.project.json");
	});

	it("should throw when a referenced .project.json does not exist", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem } = makeFileSystem();
		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				missing: { $path: "nonexistent.project.json" },
			},
		};

		expect(() => {
			return resolveNestedProjects({ rootDirectory: temporaryDirectory, tree }, fileSystem);
		}).toThrow("Could not read nested Rojo project: nonexistent.project.json");
	});

	it("should throw on circular project references", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();
		fs.writeFileSync(
			path.join(temporaryDirectory, "a.project.json"),
			JSON.stringify({ name: "A", tree: { $path: "b.project.json" } }),
		);
		fs.writeFileSync(
			path.join(temporaryDirectory, "b.project.json"),
			JSON.stringify({ name: "B", tree: { $path: "a.project.json" } }),
		);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				Cycle: { $path: "a.project.json" },
			},
		};

		expect(() => {
			return resolveNestedProjects({ rootDirectory: temporaryDirectory, tree }, fileSystem);
		}).toThrow("Circular project reference");
	});

	it("should leave non-string $path values unchanged", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			Workspace: { $path: { optional: "maybe" } },
		};

		const { directory: temporaryDirectory, fileSystem } = makeFileSystem();
		const result = resolveNestedProjects(
			{ rootDirectory: temporaryDirectory, tree },
			fileSystem,
		);

		expect(result).toStrictEqual(tree);
	});

	it("should rebase an optional $path inside a nested project", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();
		fs.mkdirSync(path.join(temporaryDirectory, "pkg"));
		fs.writeFileSync(
			path.join(temporaryDirectory, "pkg", "default.project.json"),
			JSON.stringify({ name: "Pkg", tree: { $path: { optional: "src" } } }),
		);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: { Pkg: { $path: "pkg/default.project.json" } },
		} satisfies RojoTreeNode;

		const result = resolveNestedProjects(
			{ rootDirectory: temporaryDirectory, tree },
			fileSystem,
		);

		expect(result).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: { Pkg: { $path: { optional: "pkg/src" } } },
		});
	});

	it("should allow the same project file referenced from different branches", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();
		fs.writeFileSync(
			path.join(temporaryDirectory, "loader.project.json"),
			JSON.stringify({ name: "Loader", tree: { $path: "src/loader" } }),
		);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ServerScriptService: {
				Loader: { $path: "loader.project.json" },
			},
			StarterPlayer: {
				Loader: { $path: "loader.project.json" },
			},
		};

		const result = resolveNestedProjects(
			{ rootDirectory: temporaryDirectory, tree },
			fileSystem,
		);

		expect(result).toStrictEqual({
			$className: "DataModel",
			ServerScriptService: {
				Loader: { $path: "src/loader" },
			},
			StarterPlayer: {
				Loader: { $path: "src/loader" },
			},
		});
	});

	it("should resolve nested project paths relative to the project file's directory", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();
		const subdirectory = path.join(temporaryDirectory, "packages", "my-pkg");
		fs.mkdirSync(subdirectory, { recursive: true });
		fs.writeFileSync(
			path.join(subdirectory, "default.project.json"),
			JSON.stringify({ name: "my-pkg", tree: { $path: "src" } }),
		);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				"my-pkg": { $path: "packages/my-pkg/default.project.json" },
			},
		};

		const result = resolveNestedProjects(
			{ rootDirectory: temporaryDirectory, tree },
			fileSystem,
		);

		expect(result).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				"my-pkg": { $path: "packages/my-pkg/src" },
			},
		});
	});

	it("should inline a $path directory that contains a default.project.json", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem } = makeNestedDirectoryProject();

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ServerScriptService: {
				pkg: { $path: "pkg" },
			},
		};

		const result = resolveNestedProjects(
			{ rootDirectory: temporaryDirectory, tree },
			fileSystem,
		);

		expect(result).toStrictEqual({
			$className: "DataModel",
			ServerScriptService: {
				pkg: { $path: "pkg/src" },
			},
		});
	});

	it("should follow $path '..' into a parent directory's default.project.json", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();
		fs.writeFileSync(
			path.join(temporaryDirectory, "default.project.json"),
			JSON.stringify({ name: "rx", tree: { $path: "src" } }),
		);
		const testDirectory = path.join(temporaryDirectory, "test");
		fs.mkdirSync(testDirectory, { recursive: true });

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ServerScriptService: {
				rx: { $path: ".." },
			},
		};

		const result = resolveNestedProjects({ rootDirectory: testDirectory, tree }, fileSystem);

		expect(result).toStrictEqual({
			$className: "DataModel",
			ServerScriptService: {
				rx: { $path: "../src" },
			},
		});
	});

	it("should leave a $path directory without default.project.json unchanged", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();
		fs.mkdirSync(path.join(temporaryDirectory, "src"), { recursive: true });

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				Src: { $path: "src" },
			},
		};

		const result = resolveNestedProjects(
			{ rootDirectory: temporaryDirectory, tree },
			fileSystem,
		);

		expect(result).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				Src: { $path: "src" },
			},
		});
	});

	it("should leave an absolute $path as written", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem } = makeFileSystem();
		const projectDirectory = path.join(temporaryDirectory, "project");
		const externalDirectory = path.join(temporaryDirectory, "external", "out");

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				External: { $path: externalDirectory },
			},
		};

		const result = resolveNestedProjects({ rootDirectory: projectDirectory, tree }, fileSystem);

		expect(result).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				External: { $path: externalDirectory.replaceAll("\\", "/") },
			},
		});
	});

	it("should leave a drive-letter $path as written on a host without drives", () => {
		expect.assertions(1);

		// `path.isAbsolute` reads this as relative on Linux, which would rebase
		// the mount and resolve the same project file into two different trees
		// depending on which machine read it.
		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				External: { $path: "Z:/external/out" },
			},
		};

		const result = resolveNestedProjects(
			{ rootDirectory: path.resolve("project"), tree },
			makeFileSystem().fileSystem,
		);

		expect(result).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				External: { $path: "Z:/external/out" },
			},
		});
	});

	it("should leave a backslash-rooted $path as written on a host without drives", () => {
		expect.assertions(1);

		// A drive-relative root and a UNC share, the two roots a Windows project
		// writes with backslashes. `path.isAbsolute` reads both as relative on
		// Linux, which would rebase them onto the project directory.
		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				Drive: { $path: "\\external\\out" },
				Share: { $path: "\\\\build-server\\share\\out" },
			},
		};

		const result = resolveNestedProjects(
			{ rootDirectory: path.resolve("project"), tree },
			makeFileSystem().fileSystem,
		);

		expect(result).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				Drive: { $path: "/external/out" },
				Share: { $path: "//build-server/share/out" },
			},
		});
	});

	it("should leave an absolute $path inside a nested project as written", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();
		const packageDirectory = path.join(temporaryDirectory, "packages", "my-pkg");
		const externalDirectory = path.join(temporaryDirectory, "external", "out");
		fs.mkdirSync(packageDirectory, { recursive: true });
		fs.writeFileSync(
			path.join(packageDirectory, "default.project.json"),
			JSON.stringify({
				name: "my-pkg",
				tree: {
					$className: "Folder",
					Generated: { $path: externalDirectory },
					Src: { $path: "src" },
				},
			}),
		);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				"my-pkg": { $path: "packages/my-pkg/default.project.json" },
			},
		};

		const result = resolveNestedProjects(
			{ rootDirectory: temporaryDirectory, tree },
			fileSystem,
		);

		expect(result).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				"my-pkg": {
					$className: "Folder",
					Generated: { $path: externalDirectory.replaceAll("\\", "/") },
					Src: { $path: "packages/my-pkg/src" },
				},
			},
		});
	});

	it("should inline a nested project named by an absolute $path", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem } = makeNestedDirectoryProject();
		const projectDirectory = path.join(temporaryDirectory, "project");
		const packageDirectory = path.join(temporaryDirectory, "pkg");

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ServerScriptService: {
				pkg: { $path: packageDirectory },
			},
		};

		const result = resolveNestedProjects({ rootDirectory: projectDirectory, tree }, fileSystem);

		expect(result).toStrictEqual({
			$className: "DataModel",
			ServerScriptService: {
				pkg: { $path: "../pkg/src" },
			},
		});
	});
});

describe(resolveNestedProjectSources, () => {
	it("should report no project files when nothing is inlined", () => {
		expect.assertions(2);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				client: { $path: "out/client" },
			},
		};

		const { directory: temporaryDirectory, fileSystem } = makeFileSystem();
		const result = resolveNestedProjectSources(
			{ rootDirectory: temporaryDirectory, tree },
			fileSystem,
		);

		expect(result.projectFiles).toStrictEqual([]);
		expect(result.tree).toStrictEqual(tree);
	});

	it("should report the absolute path of each inlined nested project", () => {
		expect.assertions(2);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();
		const projectFile = path.join(temporaryDirectory, "default.project.json");
		fs.writeFileSync(projectFile, JSON.stringify({ name: "my-pkg", tree: { $path: "src" } }));

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				"my-pkg": { $path: "default.project.json" },
			},
		};

		const result = resolveNestedProjectSources(
			{ rootDirectory: temporaryDirectory, tree },
			fileSystem,
		);

		expect(result.projectFiles).toStrictEqual([projectFile]);
		expect(result.tree).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				"my-pkg": { $path: "src" },
			},
		});
	});

	it("should report every project file in a chained reference", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();
		const outer = path.join(temporaryDirectory, "a.project.json");
		const inner = path.join(temporaryDirectory, "b.project.json");
		fs.writeFileSync(outer, JSON.stringify({ name: "A", tree: { $path: "b.project.json" } }));
		fs.writeFileSync(inner, JSON.stringify({ name: "B", tree: { $path: "src" } }));

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				Chain: { $path: "a.project.json" },
			},
		};

		const result = resolveNestedProjectSources(
			{ rootDirectory: temporaryDirectory, tree },
			fileSystem,
		);

		expect(new Set(result.projectFiles)).toStrictEqual(new Set([inner, outer]));
	});

	it("should report a project file referenced from two branches once", () => {
		expect.assertions(1);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();
		const projectFile = path.join(temporaryDirectory, "loader.project.json");
		fs.writeFileSync(
			projectFile,
			JSON.stringify({ name: "Loader", tree: { $path: "src/loader" } }),
		);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ServerScriptService: {
				Loader: { $path: "loader.project.json" },
			},
			StarterPlayer: {
				Loader: { $path: "loader.project.json" },
			},
		};

		const result = resolveNestedProjectSources(
			{ rootDirectory: temporaryDirectory, tree },
			fileSystem,
		);

		expect(result.projectFiles).toStrictEqual([projectFile]);
	});

	it("should report a directory mount that contains a default.project.json", () => {
		expect.assertions(2);

		const { directory: temporaryDirectory, fileSystem, fs } = makeFileSystem();
		const packageDirectory = path.join(temporaryDirectory, "pkg");
		fs.mkdirSync(packageDirectory, { recursive: true });
		const projectFile = path.join(packageDirectory, "default.project.json");
		fs.writeFileSync(projectFile, JSON.stringify({ name: "pkg", tree: { $path: "src" } }));

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ServerScriptService: {
				pkg: { $path: "pkg" },
			},
		};

		const result = resolveNestedProjectSources(
			{ rootDirectory: temporaryDirectory, tree },
			fileSystem,
		);

		expect(result.projectFiles).toStrictEqual([projectFile]);
		expect(result.tree).toStrictEqual({
			$className: "DataModel",
			ServerScriptService: {
				pkg: { $path: "pkg/src" },
			},
		});
	});
});
