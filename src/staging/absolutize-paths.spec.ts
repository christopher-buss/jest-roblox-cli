import { isRojoTreeNode } from "@isentinel/rojo-utils";
import type { RojoTreeNode } from "@isentinel/rojo-utils";

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixPath, posixRoot } from "#test/mocks/posix-path.ts";
import { absolutizePackagePaths } from "./absolutize-paths.ts";
import type { PathRedirect } from "./path-redirect.ts";

const ROOT = path.resolve("/repo");
const FOO_DIR = path.join(ROOT, "packages/foo");
const FOO_PROJECT = path.join(FOO_DIR, "test.project.json");
const SERVER_SHADOW = path.join(FOO_DIR, ".jest-roblox/coverage/src/server");
const SRC_SPINE = path.join(FOO_DIR, ".jest-roblox/coverage/.spine/src");

function child(node: RojoTreeNode | undefined, ...keys: Array<string>): RojoTreeNode | undefined {
	return keys.reduce<RojoTreeNode | undefined>((current, key) => {
		const value = current?.[key];
		return isRojoTreeNode(value) ? value : undefined;
	}, node);
}

function root(luauRoot: string, shadowDirectory: string): PathRedirect {
	return { from: posixRoot(path.join(FOO_DIR, luauRoot)), to: posixPath(shadowDirectory) };
}

function absolutize({
	files,
	redirects,
	spine,
	tree,
}: {
	files: Record<string, string>;
	redirects?: Array<PathRedirect>;
	spine?: Array<PathRedirect>;
	tree: RojoTreeNode;
}): RojoTreeNode {
	const { fileSystem } = createMemoryFileSystem(
		Object.fromEntries(
			Object.entries(files).map(([file, body]) => [path.join(FOO_DIR, file), body]),
		),
	);
	return absolutizePackagePaths({
		descriptor: {
			redirects,
			rojoProjectPath: FOO_PROJECT,
			spine,
		},
		fileSystem,
		node: tree,
	});
}

const SRC_MOUNT: RojoTreeNode = {
	ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
};

describe(absolutizePackagePaths, () => {
	it("should rebase an optional $path and keep its optional wrapper", () => {
		expect.assertions(1);

		const tree = absolutize({
			files: {},
			tree: {
				ReplicatedStorage: {
					$className: "ReplicatedStorage",
					DevPackages: { $path: { optional: "DevPackages" } },
				},
			},
		});

		expect(child(tree, "ReplicatedStorage", "DevPackages")!.$path).toStrictEqual({
			optional: posixPath(path.join(FOO_DIR, "DevPackages")),
		});
	});

	it("should rebase a child whose name ends in a dollar sign", () => {
		expect.assertions(1);

		const tree = absolutize({
			files: {},
			tree: { Price$: { $path: "price" } },
		});

		expect(child(tree, "Price$")!.$path).toBe(posixPath(path.join(FOO_DIR, "price")));
	});

	describe("coverage roots below a $path mount", () => {
		it("should demote an optional mount onto the spine", () => {
			expect.assertions(2);

			const tree = absolutize({
				files: { "src/server/init.luau": "" },
				redirects: [root("src/server", SERVER_SHADOW)],
				spine: [root("src", SRC_SPINE)],
				tree: {
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						$path: { optional: "src" },
					},
				},
			});

			const mount = child(tree, "ReplicatedStorage")!;

			expect(mount.$path).toBe(posixPath(SRC_SPINE));
			expect(child(mount, "server")!.$path).toBe(posixPath(SERVER_SHADOW));
		});

		it("should demote the containing mount onto the spine and hang the root off it", () => {
			expect.assertions(5);

			const tree = absolutize({
				files: {
					"src/$reserved/init.luau": "",
					"src/client/init.luau": "",
					"src/loose.luau": "",
					"src/server/init.luau": "",
				},
				redirects: [root("src/server", SERVER_SHADOW)],
				spine: [root("src", SRC_SPINE)],
				tree: SRC_MOUNT,
			});

			const mount = child(tree, "ReplicatedStorage")!;

			expect(mount.$path).toBe(posixPath(SRC_SPINE));
			expect(mount.$className).toBe("ReplicatedStorage");
			expect(child(mount, "server")!.$path).toBe(posixPath(SERVER_SHADOW));
			expect(child(mount, "client")!.$path).toBe(posixPath(path.join(FOO_DIR, "src/client")));
			expect([mount["loose.luau"], mount["$reserved"]]).toStrictEqual([undefined, undefined]);
		});

		it("should carry the demote down every level of the spine", () => {
			expect.assertions(3);

			const shadowDirectory = path.join(FOO_DIR, ".jest-roblox/coverage/src/modules/ecs");
			const modulesSpine = path.join(FOO_DIR, ".jest-roblox/coverage/.spine/src/modules");

			const tree = absolutize({
				files: {
					"src/modules/ecs/world.luau": "",
					"src/modules/net/init.luau": "",
				},
				redirects: [root("src/modules/ecs", shadowDirectory)],
				spine: [root("src", SRC_SPINE), root("src/modules", modulesSpine)],
				tree: SRC_MOUNT,
			});

			const modules = child(tree, "ReplicatedStorage", "modules")!;

			expect(modules.$path).toBe(posixPath(modulesSpine));
			expect(child(modules, "ecs")!.$path).toBe(posixPath(shadowDirectory));
			expect(child(modules, "net")!.$path).toBe(
				posixPath(path.join(FOO_DIR, "src/modules/net")),
			);
		});

		it("should leave a directory the project already declares to the project", () => {
			expect.assertions(1);

			const tree = absolutize({
				files: { "src/client/init.luau": "", "src/server/init.luau": "" },
				redirects: [root("src/server", SERVER_SHADOW)],
				spine: [root("src", SRC_SPINE)],
				tree: {
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						$path: "src",
						client: { $className: "Folder" },
					},
				},
			});

			expect(child(tree, "ReplicatedStorage", "client")).toStrictEqual({
				$className: "Folder",
			});
		});
	});
});
