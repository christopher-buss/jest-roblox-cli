import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	collectPaths,
	collectRequiredPaths,
	rebaseTreePaths,
	resolveMountPath,
} from "./mount-paths.ts";
import type { RojoTreeNode } from "./rojo-types.ts";

describe(collectPaths, () => {
	it("should filter object metadata and optional-looking child properties", () => {
		expect.assertions(2);

		const tree = {
			$properties: { Hidden: { $path: "hidden" } },
			Child$: { Leaf: { $path: "visible" }, optional: "ordinary-field" },
		};
		const all: Array<string> = [];
		const required: Array<string> = [];
		collectPaths(tree, all);
		collectRequiredPaths(tree, required);

		expect(all).toStrictEqual(["visible"]);
		expect(required).toStrictEqual(["visible"]);
	});

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

	it("should collect the inner path of an optional $path", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			Workspace: { $path: { optional: "maybe\\workspace" } },
		};

		const result: Array<string> = [];
		collectPaths(tree, result);

		expect(result).toStrictEqual(["maybe/workspace"]);
	});

	it("should descend into a child named optional", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			Workspace: { optional: { $path: "out/optional" } },
		};

		const result: Array<string> = [];
		collectPaths(tree, result);

		expect(result).toStrictEqual(["out/optional"]);
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

describe(collectRequiredPaths, () => {
	it("should skip an optional $path", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				DevPackages: { $path: { optional: "DevPackages" } },
				lib: { $path: "out\\lib" },
			},
		};

		const result: Array<string> = [];
		collectRequiredPaths(tree, result);

		expect(result).toStrictEqual(["out/lib"]);
	});
});

describe(resolveMountPath, () => {
	it("should join a relative mount onto the base directory", () => {
		expect.assertions(1);

		expect(resolveMountPath("/repo/place", "out/client")).toBe("/repo/place/out/client");
	});

	it("should collapse traversal in a relative mount", () => {
		expect.assertions(1);

		expect(resolveMountPath("/repo/place", "../shared/out")).toBe("/repo/shared/out");
	});

	// Against a drive base, so the first row is the case `path.resolve` gets
	// wrong: it reads a drive-less absolute mount as drive-relative on Windows
	// and answers with the base's drive, naming a directory that does not exist.
	it.for([
		{ expected: "/external/out", mount: "/external/out" },
		{ expected: "D:/external/out", mount: "D:/external/out" },
		{ expected: "D:/external/out", mount: "D:\\external\\out" },
		{ expected: "/external/out", mount: "\\external\\out" },
	])("should return the absolute mount $mount unjoined", ({ expected, mount }) => {
		expect.assertions(1);

		expect(resolveMountPath("C:/repo/place", mount)).toBe(expected);
	});

	it("should return a posix path for a backslash base directory", () => {
		expect.assertions(1);

		expect(resolveMountPath("D:\\repo\\place", "out/client")).toBe("D:/repo/place/out/client");
	});

	// `join` keeps a trailing separator where `resolve` ate it. Containment
	// tests downstream append their own `/`, so a mount ending in one sits
	// inside nothing and holds nothing.
	it.for([
		{ expected: "/repo/place/out", mount: "out/" },
		{ expected: "/repo/place", mount: "./" },
		{ expected: "/repo/place/out/client", mount: "out/client/" },
		{ expected: "/external/out", mount: "/external/out/" },
		{ expected: "D:/external/out", mount: "D:\\external\\out\\" },
	])("should drop the trailing separator on $mount", ({ expected, mount }) => {
		expect.assertions(1);

		expect(resolveMountPath("/repo/place", mount)).toBe(expected);
	});

	it.for([
		{ label: "posix", mount: "/" },
		{ label: "drive", mount: "D:/" },
	])("should keep a bare $label root whole", ({ mount }) => {
		expect.assertions(1);

		// Nothing left to name if the separator goes.
		expect(resolveMountPath("/repo/place", mount)).toBe(mount);
	});

	it("should leave a mount that contains a root a valid prefix of what it holds", () => {
		expect.assertions(1);

		// The shape every coverage containment test needs: `${mount}/` has to be
		// the prefix of a root below it, which a trailing separator would break.
		const mount = resolveMountPath("/repo/place", "out/");
		const root = resolveMountPath("/repo/place", "out/client");

		expect(root.startsWith(`${mount}/`)).toBeTrue();
	});
});

describe(rebaseTreePaths, () => {
	it("should rebase nested directories without interpreting child optional fields as mounts", () => {
		expect.assertions(1);

		const root = path.resolve("project");
		const tree = {
			$properties: { Hidden: { $path: "hidden" } },
			Child$: {
				Leaf: { $path: "source/deep" },
				Maybe: { $path: { optional: "other/deep" } },
				optional: "ordinary-field",
			},
		};

		expect(
			rebaseTreePaths({ fromDirectory: root, node: tree, toDirectory: path.dirname(root) }),
		).toStrictEqual({
			$properties: tree.$properties,
			Child$: {
				Leaf: { $path: "project/source/deep" },
				Maybe: { $path: { optional: "project/other/deep" } },
				optional: "ordinary-field",
			},
		});
	});

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

		const result = rebaseTreePaths({
			fromDirectory: testDirectory,
			node: tree,
			toDirectory: packageDirectory,
		});

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

		const result = rebaseTreePaths({ fromDirectory: base, node: tree, toDirectory: base });

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

		const result = rebaseTreePaths({
			fromDirectory: testDirectory,
			node: tree,
			toDirectory: packageDirectory,
		});

		expect(result).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: {
				Packages: { $path: "node_modules" },
				Src: { $path: "src" },
			},
		});
	});

	it("should rebase an optional $path and keep its wrapper", () => {
		expect.assertions(1);

		const base = path.resolve("repo", "pkg");
		const tree = {
			$className: "DataModel",
			Workspace: { $path: { optional: "../maybe" } },
		} satisfies RojoTreeNode;

		const result = rebaseTreePaths({
			fromDirectory: path.join(base, "test"),
			node: tree,
			toDirectory: base,
		});

		expect(result).toStrictEqual({
			$className: "DataModel",
			Workspace: { $path: { optional: "maybe" } },
		});
	});
});
