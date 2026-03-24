import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import type { RojoTreeNode } from "../types/rojo.ts";
import { collectPaths, resolveNestedProjects } from "./rojo-tree.ts";

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

		// Simulate development.project.json referencing default.project.json
		// which in turn has $path: "src"
		const result = resolveNestedProjects(tree, temporaryDirectory);
		fs.rmSync(temporaryDirectory, { force: true, recursive: true });

		expect(result).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				"uuid-generator": { $path: "src" },
			},
		});
	});

	it("should throw when a referenced .project.json does not exist", () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-tree-test-"));
		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				missing: { $path: "nonexistent.project.json" },
			},
		};

		try {
			expect(() => resolveNestedProjects(tree, temporaryDirectory)).toThrow(
				"nonexistent.project.json",
			);
		} finally {
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });
		}
	});

	it("should throw on circular project references", () => {
		expect.assertions(1);

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rojo-tree-test-"));
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

		try {
			expect(() => resolveNestedProjects(tree, temporaryDirectory)).toThrow(
				"Circular project reference",
			);
		} finally {
			fs.rmSync(temporaryDirectory, { force: true, recursive: true });
		}
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
});
