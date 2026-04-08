import { describe, expect, it } from "vitest";

import { findInTree, matchNodePath } from "./tree-mapper.ts";
import type { RojoTreeNode } from "./types.ts";

describe(matchNodePath, () => {
	it("should return undefined when $path is not a string", () => {
		expect.assertions(1);

		const node: RojoTreeNode = { $path: { optional: "maybe" } };

		expect(matchNodePath(node, "out/client", "ReplicatedStorage/client")).toBeUndefined();
	});

	it("should return DataModel path on exact match", () => {
		expect.assertions(1);

		const node: RojoTreeNode = { $path: "out/client" };

		expect(matchNodePath(node, "out/client", "ReplicatedStorage/client")).toBe(
			"ReplicatedStorage/client",
		);
	});

	it("should strip trailing slash before matching", () => {
		expect.assertions(1);

		const node: RojoTreeNode = { $path: "out/client/" };

		expect(matchNodePath(node, "out/client", "ReplicatedStorage/client")).toBe(
			"ReplicatedStorage/client",
		);
	});

	it("should return nested DataModel path when target is under $path", () => {
		expect.assertions(1);

		const node: RojoTreeNode = { $path: "out/client" };

		expect(matchNodePath(node, "out/client/ui", "ReplicatedStorage/client")).toBe(
			"ReplicatedStorage/client/ui",
		);
	});

	it("should return undefined when paths do not match", () => {
		expect.assertions(1);

		const node: RojoTreeNode = { $path: "out/server" };

		expect(matchNodePath(node, "out/client", "ServerScriptService/server")).toBeUndefined();
	});

	it("should not match partial directory names", () => {
		expect.assertions(1);

		const node: RojoTreeNode = { $path: "out/cli" };

		expect(matchNodePath(node, "out/client", "ReplicatedStorage/cli")).toBeUndefined();
	});

	it("should return undefined when node has no $path", () => {
		expect.assertions(1);

		const node: RojoTreeNode = { $className: "Folder" };

		expect(matchNodePath(node, "out/client", "ReplicatedStorage/folder")).toBeUndefined();
	});
});

const simpleRojoTree: RojoTreeNode = {
	$className: "DataModel",
	ReplicatedStorage: {
		client: { $path: "out/client" },
	},
	ServerScriptService: {
		server: { $path: "out/server" },
	},
};

describe(findInTree, () => {
	it("should find exact $path match", () => {
		expect.assertions(1);

		expect(findInTree(simpleRojoTree, "out/client", "")).toBe("ReplicatedStorage/client");
	});

	it("should find nested path under $path entry", () => {
		expect.assertions(1);

		expect(findInTree(simpleRojoTree, "out/client/ui", "")).toBe("ReplicatedStorage/client/ui");
	});

	it("should find deeply nested tree structures", () => {
		expect.assertions(1);

		const nestedTree: RojoTreeNode = {
			$className: "DataModel",
			ReplicatedStorage: {
				shared: {
					lib: { $path: "out/shared/lib" },
				},
			},
		};

		expect(findInTree(nestedTree, "out/shared/lib", "")).toBe("ReplicatedStorage/shared/lib");
	});

	it("should return undefined when no match", () => {
		expect.assertions(1);

		expect(findInTree(simpleRojoTree, "out/unknown", "")).toBeUndefined();
	});

	it("should skip $ prefixed keys", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			$properties: { Name: "Game" },
		};

		expect(findInTree(tree, "out/client", "")).toBeUndefined();
	});

	it("should skip non-object values", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			$ignoreUnknownInstances: true,
		};

		expect(findInTree(tree, "out/client", "")).toBeUndefined();
	});

	it("should build DataModel path from current path", () => {
		expect.assertions(1);

		const subtree: RojoTreeNode = {
			lib: { $path: "out/shared/lib" },
		};

		expect(findInTree(subtree, "out/shared/lib", "ReplicatedStorage/shared")).toBe(
			"ReplicatedStorage/shared/lib",
		);
	});
});
