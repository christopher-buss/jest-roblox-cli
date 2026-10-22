import { describe, expect, it, vi } from "vitest";

import type { PathClassifier, PathKind } from "./mount-collector.ts";
import { collectMounts, pruneAncestors } from "./mount-collector.ts";
import type { RojoTreeNode } from "./types.ts";

function allDirectories(): PathKind {
	return "directory";
}

function makeClassifier(kinds: Record<string, PathKind>): PathClassifier {
	function classify(fsPath: string): PathKind {
		return kinds[fsPath] ?? "missing";
	}

	return classify;
}

describe(collectMounts, () => {
	it("should return empty array for tree with no $path entries", () => {
		expect.assertions(1);

		const tree = { $className: "DataModel" } satisfies RojoTreeNode;

		expect(collectMounts(tree, "", allDirectories)).toStrictEqual([]);
	});

	it("should collect a single directory $path entry", () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				client: { $path: "out/client" },
			},
		} satisfies RojoTreeNode;

		expect(collectMounts(tree, "", allDirectories)).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/client", fsPath: "out/client" },
		]);
	});

	it("should collect multiple $path entries in nested tree", () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				client: { $path: "out/client" },
				shared: { $path: "out/shared" },
			},
			ServerScriptService: {
				server: { $path: "out/server" },
			},
		} satisfies RojoTreeNode;

		const result = collectMounts(tree, "", allDirectories);

		expect(result).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/client", fsPath: "out/client" },
			{ dataModelPath: "ReplicatedStorage/shared", fsPath: "out/shared" },
			{ dataModelPath: "ServerScriptService/server", fsPath: "out/server" },
		]);
	});

	it("should normalize trailing slash in $path", () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				client: { $path: "out/client/" },
			},
		} satisfies RojoTreeNode;

		expect(collectMounts(tree, "", allDirectories)).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/client", fsPath: "out/client" },
		]);
	});

	it("should skip file-valued $path entries", () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Constants: { $path: "out/shared/Constants.luau" },
				shared: { $path: "out/shared" },
			},
		} satisfies RojoTreeNode;

		const classify = makeClassifier({
			"out/shared": "directory",
			"out/shared/Constants.luau": "file",
		});

		expect(collectMounts(tree, "", classify)).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/shared", fsPath: "out/shared" },
		]);
	});

	it("should skip missing paths silently", () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				client: { $path: "out/client" },
				missing: { $path: "out/missing" },
			},
		} satisfies RojoTreeNode;

		const classify = makeClassifier({
			"out/client": "directory",
		});

		const result = collectMounts(tree, "", classify);

		expect(result).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/client", fsPath: "out/client" },
		]);
	});

	it("should skip $path entries pointing at .project.json files", () => {
		expect.assertions(2);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				nested: { $path: "packages/shared/default.project.json" },
			},
		} satisfies RojoTreeNode;

		const classify = vi.fn<PathClassifier>();

		expect(collectMounts(tree, "", classify)).toStrictEqual([]);
		expect(classify).not.toHaveBeenCalled();
	});

	it("should collect an optional directory $path entry", () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				optional: { $path: { optional: "out/maybe" } },
			},
		} satisfies RojoTreeNode;

		expect(collectMounts(tree, "", allDirectories)).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/optional", fsPath: "out/maybe" },
		]);
	});

	it("should skip keys that start with $", () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			$properties: { Name: "Game" },
		} satisfies RojoTreeNode;

		expect(collectMounts(tree, "", allDirectories)).toStrictEqual([]);
	});

	it("should skip non-object values", () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			$ignoreUnknownInstances: true,
		} satisfies RojoTreeNode;

		expect(collectMounts(tree, "", allDirectories)).toStrictEqual([]);
	});

	it("should walk deeply nested tree structures", () => {
		expect.assertions(1);

		const tree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Packages: {
					friends: {
						Client: { $path: "src/Client" },
						Shared: { $path: "src/Shared" },
					},
				},
			},
		} satisfies RojoTreeNode;

		expect(collectMounts(tree, "", allDirectories)).toStrictEqual([
			{
				dataModelPath: "ReplicatedStorage/Packages/friends/Client",
				fsPath: "src/Client",
			},
			{
				dataModelPath: "ReplicatedStorage/Packages/friends/Shared",
				fsPath: "src/Shared",
			},
		]);
	});

	it("should build DataModel paths from given current prefix", () => {
		expect.assertions(1);

		const subtree = {
			lib: { $path: "out/lib" },
		} satisfies RojoTreeNode;

		expect(collectMounts(subtree, "ReplicatedStorage/shared", allDirectories)).toStrictEqual([
			{ dataModelPath: "ReplicatedStorage/shared/lib", fsPath: "out/lib" },
		]);
	});
});

describe(pruneAncestors, () => {
	it("should return empty array for empty input", () => {
		expect.assertions(1);

		expect(pruneAncestors([])).toStrictEqual([]);
	});

	it("should pass unrelated paths through unchanged", () => {
		expect.assertions(1);

		const paths = ["ReplicatedStorage/Client", "ServerScriptService/Server"];

		expect(pruneAncestors(paths)).toStrictEqual(paths);
	});

	it("should drop descendant when ancestor is present", () => {
		expect.assertions(1);

		expect(
			pruneAncestors(["ReplicatedStorage/Client", "ReplicatedStorage/Client/Systems"]),
		).toStrictEqual(["ReplicatedStorage/Client"]);
	});

	it("should drop descendant regardless of input order", () => {
		expect.assertions(1);

		expect(
			pruneAncestors(["ReplicatedStorage/Client/Systems", "ReplicatedStorage/Client"]),
		).toStrictEqual(["ReplicatedStorage/Client"]);
	});

	it("should respect segment boundaries when testing ancestry", () => {
		expect.assertions(1);

		expect(
			pruneAncestors(["ReplicatedStorage/Client", "ReplicatedStorage/ClientExtras"]),
		).toStrictEqual(["ReplicatedStorage/Client", "ReplicatedStorage/ClientExtras"]);
	});

	it("should keep identical paths unchanged (caller dedupes)", () => {
		expect.assertions(1);

		expect(pruneAncestors(["A/B", "A/B"])).toStrictEqual(["A/B", "A/B"]);
	});

	it("should drop all descendants under a common ancestor", () => {
		expect.assertions(1);

		expect(
			pruneAncestors([
				"ReplicatedStorage/Client",
				"ReplicatedStorage/Client/Systems",
				"ReplicatedStorage/Client/Components",
				"ServerScriptService/Server",
			]),
		).toStrictEqual(["ReplicatedStorage/Client", "ServerScriptService/Server"]);
	});
});
