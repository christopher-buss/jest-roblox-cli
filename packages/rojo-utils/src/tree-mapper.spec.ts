import { describe, expect, it } from "vitest";

import type { RojoTreeNode } from "./rojo-types.ts";
import { findInTree, matchNodePath } from "./tree-mapper.ts";

describe(matchNodePath, () => {
	it("should match an optional $path exactly", () => {
		expect.assertions(1);

		const node = { $path: { optional: "out/client" } } satisfies RojoTreeNode;

		expect(
			matchNodePath({
				childDataModelPath: "ReplicatedStorage/client",
				childNode: node,
				targetPath: "out/client",
			}),
		).toBe("ReplicatedStorage/client");
	});

	it("should match a target under an optional $path", () => {
		expect.assertions(1);

		const node = { $path: { optional: "out/client" } } satisfies RojoTreeNode;

		expect(
			matchNodePath({
				childDataModelPath: "ReplicatedStorage/client",
				childNode: node,
				targetPath: "out/client/ui",
			}),
		).toBe("ReplicatedStorage/client/ui");
	});

	it("should return DataModel path on exact match", () => {
		expect.assertions(1);

		const node: RojoTreeNode = { $path: "out/client" };

		expect(
			matchNodePath({
				childDataModelPath: "ReplicatedStorage/client",
				childNode: node,
				targetPath: "out/client",
			}),
		).toBe("ReplicatedStorage/client");
	});

	it("should strip trailing slash before matching", () => {
		expect.assertions(1);

		const node: RojoTreeNode = { $path: "out/client/" };

		expect(
			matchNodePath({
				childDataModelPath: "ReplicatedStorage/client",
				childNode: node,
				targetPath: "out/client",
			}),
		).toBe("ReplicatedStorage/client");
	});

	it("should return nested DataModel path when target is under $path", () => {
		expect.assertions(1);

		const node: RojoTreeNode = { $path: "out/client" };

		expect(
			matchNodePath({
				childDataModelPath: "ReplicatedStorage/client",
				childNode: node,
				targetPath: "out/client/ui",
			}),
		).toBe("ReplicatedStorage/client/ui");
	});

	it("should return undefined when paths do not match", () => {
		expect.assertions(1);

		const node: RojoTreeNode = { $path: "out/server" };

		expect(
			matchNodePath({
				childDataModelPath: "ServerScriptService/server",
				childNode: node,
				targetPath: "out/client",
			}),
		).toBeUndefined();
	});

	it("should not match partial directory names", () => {
		expect.assertions(1);

		const node: RojoTreeNode = { $path: "out/cli" };

		expect(
			matchNodePath({
				childDataModelPath: "ReplicatedStorage/cli",
				childNode: node,
				targetPath: "out/client",
			}),
		).toBeUndefined();
	});

	it("should return undefined when node has no $path", () => {
		expect.assertions(1);

		const node: RojoTreeNode = { $className: "Folder" };

		expect(
			matchNodePath({
				childDataModelPath: "ReplicatedStorage/folder",
				childNode: node,
				targetPath: "out/client",
			}),
		).toBeUndefined();
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
	it("should skip object metadata but search child names ending in a dollar", () => {
		expect.assertions(2);

		const tree = { $properties: { Hidden: { $path: "source" } }, Child$: { $path: "source" } };

		expect(findInTree({ currentDataModelPath: "", node: tree, targetPath: "source" })).toBe(
			"Child$",
		);
		expect(
			findInTree({
				currentDataModelPath: "",
				node: { $properties: { Hidden: { $path: "source" } } },
				targetPath: "source",
			}),
		).toBeUndefined();
	});

	it("should find an optional $path entry", () => {
		expect.assertions(1);

		const tree = {
			ReplicatedStorage: { tests: { $path: { optional: "src/tests" } } },
		} satisfies RojoTreeNode;

		expect(findInTree({ currentDataModelPath: "", node: tree, targetPath: "src/tests" })).toBe(
			"ReplicatedStorage/tests",
		);
	});

	it("should find exact $path match", () => {
		expect.assertions(1);

		expect(
			findInTree({
				currentDataModelPath: "",
				node: simpleRojoTree,
				targetPath: "out/client",
			}),
		).toBe("ReplicatedStorage/client");
	});

	it("should find nested path under $path entry", () => {
		expect.assertions(1);

		expect(
			findInTree({
				currentDataModelPath: "",
				node: simpleRojoTree,
				targetPath: "out/client/ui",
			}),
		).toBe("ReplicatedStorage/client/ui");
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

		expect(
			findInTree({
				currentDataModelPath: "",
				node: nestedTree,
				targetPath: "out/shared/lib",
			}),
		).toBe("ReplicatedStorage/shared/lib");
	});

	it("should return undefined when no match", () => {
		expect.assertions(1);

		expect(
			findInTree({
				currentDataModelPath: "",
				node: simpleRojoTree,
				targetPath: "out/unknown",
			}),
		).toBeUndefined();
	});

	it("should skip $ prefixed keys", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			$properties: { Name: "Game" },
		};

		expect(
			findInTree({ currentDataModelPath: "", node: tree, targetPath: "out/client" }),
		).toBeUndefined();
	});

	it("should skip non-object values", () => {
		expect.assertions(1);

		const tree: RojoTreeNode = {
			$className: "DataModel",
			$ignoreUnknownInstances: true,
		};

		expect(
			findInTree({ currentDataModelPath: "", node: tree, targetPath: "out/client" }),
		).toBeUndefined();
	});

	it("should build DataModel path from current path", () => {
		expect.assertions(1);

		const subtree: RojoTreeNode = {
			lib: { $path: "out/shared/lib" },
		};

		expect(
			findInTree({
				currentDataModelPath: "ReplicatedStorage/shared",
				node: subtree,
				targetPath: "out/shared/lib",
			}),
		).toBe("ReplicatedStorage/shared/lib");
	});
});
