import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import {
	collectPaths,
	rebaseTreePaths,
	resolveNestedProjects,
	resolveNestedProjectSources,
} from "./rojo-tree.ts";
import type { RojoTreeNode } from "./types.ts";

function createTemporaryDirectory(): string {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-tree-test-"));
	onTestFinished(() => {
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });
	});
	return temporaryDirectory;
}

describe(collectPaths, () => {
	it("should collect all $path strings from a tree", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				client: { $path: "out/client" },
			},
			ServerScriptService: {
				server: { $path: "out/server" },
			},
		};

		const result: Array<string> = [];
		collectPaths(tree, result);

		expect(result).toStrictEqual(["out/client", "out/server"]);
	});

	it("should normalize backslashes", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			Workspace: { $path: "out\\workspace" },
		};

		const result: Array<string> = [];
		collectPaths(tree, result);

		expect(result).toStrictEqual(["out/workspace"]);
	});

	it("should skip non-string $path values", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			Workspace: { $path: { optional: "maybe" } },
		};

		const result: Array<string> = [];
		collectPaths(tree, result);

		expect(result).toStrictEqual([]);
	});

	it("should return empty for a tree with no $path entries", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
		};

		const result: Array<string> = [];
		collectPaths(tree, result);

		expect(result).toStrictEqual([]);
	});
});

describe(resolveNestedProjects, () => {
	it("should return tree unchanged when no $path references .project.json", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				client: { $path: "out/client" },
			},
		};

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-tree-test-"));
		const result = resolveNestedProjects(tree, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result).toStrictEqual(tree);
	});

	it("should resolve $path pointing to a .project.json into its inner tree's $path", () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-tree-test-"));
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

		const result = resolveNestedProjects(tree, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				"my-pkg": { $path: "src" },
			},
		});
	});

	it("should merge children from the nested project's tree into the node", () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-tree-test-"));
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

		const result = resolveNestedProjects(tree, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

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

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-tree-test-"));
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

		const result = resolveNestedProjects(tree, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				"uuid-generator": { $path: "src" },
			},
		});
	});

	it("should throw with file path when nested project has malformed JSON", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory();
		fs.writeFileSync(path.join(temporaryDirectory, "bad.project.json"), "not valid json {{{");

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				bad: { $path: "bad.project.json" },
			},
		};

		expect(() => resolveNestedProjects(tree, temporaryDirectory)).toThrow("bad.project.json");
	});

	it("should throw with file path when a nested project has no tree", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory();
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

		expect(() => resolveNestedProjects(tree, temporaryDirectory)).toThrow(
			"Failed to parse nested Rojo project: treeless.project.json",
		);
	});

	it("should throw with file path when a nested project's tree is an array", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory();
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

		expect(() => resolveNestedProjects(tree, temporaryDirectory)).toThrow(
			"Failed to parse nested Rojo project: array.project.json",
		);
	});

	it("should throw when a referenced .project.json does not exist", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory();
		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				missing: { $path: "nonexistent.project.json" },
			},
		};

		expect(() => resolveNestedProjects(tree, temporaryDirectory)).toThrow(
			"Could not read nested Rojo project: nonexistent.project.json",
		);
	});

	it("should throw on circular project references", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory();
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

		expect(() => resolveNestedProjects(tree, temporaryDirectory)).toThrow(
			"Circular project reference",
		);
	});

	it("should leave non-string $path values unchanged", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			Workspace: { $path: { optional: "maybe" } },
		};

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-tree-test-"));
		const result = resolveNestedProjects(tree, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result).toStrictEqual(tree);
	});

	it("should allow the same project file referenced from different branches", () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-tree-test-"));
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

		const result = resolveNestedProjects(tree, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

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

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-tree-test-"));
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

		const result = resolveNestedProjects(tree, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				"my-pkg": { $path: "packages/my-pkg/src" },
			},
		});
	});

	it("should inline a $path directory that contains a default.project.json", () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-tree-test-"));
		const packageDirectory = path.join(temporaryDirectory, "pkg");
		fs.mkdirSync(packageDirectory, { recursive: true });
		fs.writeFileSync(
			path.join(packageDirectory, "default.project.json"),
			JSON.stringify({ name: "pkg", tree: { $path: "src" } }),
		);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ServerScriptService: {
				pkg: { $path: "pkg" },
			},
		};

		const result = resolveNestedProjects(tree, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result).toStrictEqual({
			$className: "DataModel",
			ServerScriptService: {
				pkg: { $path: "pkg/src" },
			},
		});
	});

	it("should follow $path '..' into a parent directory's default.project.json", () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-tree-test-"));
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

		const result = resolveNestedProjects(tree, testDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result).toStrictEqual({
			$className: "DataModel",
			ServerScriptService: {
				rx: { $path: "../src" },
			},
		});
	});

	it("should leave a $path directory without default.project.json unchanged", () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-tree-test-"));
		fs.mkdirSync(path.join(temporaryDirectory, "src"), { recursive: true });

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				Src: { $path: "src" },
			},
		};

		const result = resolveNestedProjects(tree, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				Src: { $path: "src" },
			},
		});
	});

	it("should leave an absolute $path as written", () => {
		expect.assertions(1);

		const temporaryDirectory = createTemporaryDirectory();
		const projectDirectory = path.join(temporaryDirectory, "project");
		const externalDirectory = path.join(temporaryDirectory, "external", "out");

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				External: { $path: externalDirectory },
			},
		};

		const result = resolveNestedProjects(tree, projectDirectory);

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

		const result = resolveNestedProjects(tree, path.join(os.tmpdir(), "project"));

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

		const result = resolveNestedProjects(tree, path.join(os.tmpdir(), "project"));

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

		const temporaryDirectory = createTemporaryDirectory();
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

		const result = resolveNestedProjects(tree, temporaryDirectory);

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

		const temporaryDirectory = createTemporaryDirectory();
		const projectDirectory = path.join(temporaryDirectory, "project");
		const packageDirectory = path.join(temporaryDirectory, "pkg");
		fs.mkdirSync(packageDirectory, { recursive: true });
		fs.writeFileSync(
			path.join(packageDirectory, "default.project.json"),
			JSON.stringify({ name: "pkg", tree: { $path: "src" } }),
		);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ServerScriptService: {
				pkg: { $path: packageDirectory },
			},
		};

		const result = resolveNestedProjects(tree, projectDirectory);

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

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-tree-test-"));
		const result = resolveNestedProjectSources(tree, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result.projectFiles).toStrictEqual([]);
		expect(result.tree).toStrictEqual(tree);
	});

	it("should report the absolute path of each inlined nested project", () => {
		expect.assertions(2);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-tree-test-"));
		const projectFile = path.join(temporaryDirectory, "default.project.json");
		fs.writeFileSync(projectFile, JSON.stringify({ name: "my-pkg", tree: { $path: "src" } }));

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				"my-pkg": { $path: "default.project.json" },
			},
		};

		const result = resolveNestedProjectSources(tree, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

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

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-tree-test-"));
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

		const result = resolveNestedProjectSources(tree, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(new Set(result.projectFiles)).toStrictEqual(new Set([inner, outer]));
	});

	it("should report a project file referenced from two branches once", () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-tree-test-"));
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

		const result = resolveNestedProjectSources(tree, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result.projectFiles).toStrictEqual([projectFile]);
	});

	it("should report a directory mount that contains a default.project.json", () => {
		expect.assertions(2);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-tree-test-"));
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

		const result = resolveNestedProjectSources(tree, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result.projectFiles).toStrictEqual([projectFile]);
		expect(result.tree).toStrictEqual({
			$className: "DataModel",
			ServerScriptService: {
				pkg: { $path: "pkg/src" },
			},
		});
	});
});

describe(rebaseTreePaths, () => {
	it("should re-express $path strings from one base directory to another", () => {
		expect.assertions(1);

		const packageDirectory = path.resolve("repo", "pkg");
		const testDirectory = path.join(packageDirectory, "test");

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ServerScriptService: {
				rx: { $path: "../src" },
			},
		};

		const result = rebaseTreePaths(tree, testDirectory, packageDirectory);

		expect(result).toStrictEqual({
			$className: "DataModel",
			ServerScriptService: {
				rx: { $path: "src" },
			},
		});
	});

	it("should return $path unchanged when both bases are equal", () => {
		expect.assertions(1);

		const base = path.resolve("repo", "pkg");
		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				Src: { $path: "src" },
			},
		};

		const result = rebaseTreePaths(tree, base, base);

		expect(result).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				Src: { $path: "src" },
			},
		});
	});

	it("should rebase every $path in a nested tree", () => {
		expect.assertions(1);

		const packageDirectory = path.resolve("repo", "pkg");
		const testDirectory = path.join(packageDirectory, "test");

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				Packages: { $path: "../node_modules" },
				Src: { $path: "../src" },
			},
		};

		const result = rebaseTreePaths(tree, testDirectory, packageDirectory);

		expect(result).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				Packages: { $path: "node_modules" },
				Src: { $path: "src" },
			},
		});
	});

	it("should leave non-string $path values unchanged", () => {
		expect.assertions(1);

		const base = path.resolve("repo", "pkg");
		const tree: RojoTreeNode = {
			$className: "DataModel",
			Workspace: { $path: { optional: "maybe" } },
		};

		const result = rebaseTreePaths(tree, path.join(base, "test"), base);

		expect(result).toStrictEqual(tree);
	});
});
