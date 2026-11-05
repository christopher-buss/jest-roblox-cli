import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { loadPackageRojoTree } from "./package-rojo-tree.ts";

describe(loadPackageRojoTree, () => {
	it("should express every $path relative to the package directory", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			"/pkg/out/shared/index.luau": "",
			"/pkg/test/default.project.json": JSON.stringify({
				name: "pkg",
				tree: { $className: "DataModel", ReplicatedStorage: { $path: "../out/shared" } },
			}),
		});

		const tree = loadPackageRojoTree({
			fileSystem,
			packageDirectory: "/pkg",
			rojoProjectPath: "/pkg/test/default.project.json",
		});

		expect(tree).toStrictEqual({
			$className: "DataModel",
			ReplicatedStorage: { $path: "out/shared" },
		});
	});
});
