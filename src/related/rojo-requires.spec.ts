import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import type { RojoRequireResolver } from "./rojo-requires.ts";
import { createRojoRequireResolver } from "./rojo-requires.ts";

const ROOT = path.resolve("/project");

type RojoRequire = Parameters<RojoRequireResolver>[1];

function at(relativePath: string): string {
	return path.join(ROOT, relativePath);
}

const PROJECT = JSON.stringify({
	name: "game",
	tree: {
		$className: "DataModel",
		ReplicatedStorage: {
			node_modules: { "@rbxts": { $path: "node_modules/@rbxts" } },
			shared: { $path: "out" },
		},
	},
});

interface Fixture {
	files?: Record<string, string>;
	links?: Record<string, string>;
	project?: string;
}

const PACKAGE_MODULE: RojoRequire = { kind: "ts-package", segments: ["@rbxts", "pkg", "src"] };

const SIBLING: RojoRequire = {
	kind: "instance",
	path: { root: "script", segments: [{ kind: "parent" }, { name: "sibling", kind: "child" }] },
};

const FILES = {
	"node_modules/@rbxts/pkg/src/init.lua": "return {}",
	"out/feature/init.luau": "return {}",
	"out/feature/part.luau": "return {}",
	"out/main.luau": "return {}",
	"out/sibling.luau": "return {}",
};

function seed(files: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(files).map(([name, source]) => [at(name), source]));
}

function resolveFrom({
	call,
	file,
	files = {},
	links = {},
	project = PROJECT,
}: Fixture & { call: RojoRequire; file: string }): string | undefined {
	const { fileSystem, volume } = createMemoryFileSystem(
		seed({ ...FILES, ...files, "default.project.json": project }),
	);
	for (const [link, target] of Object.entries(links)) {
		volume.symlinkSync(at(target), at(link));
	}

	const resolve = createRojoRequireResolver({
		fileSystem,
		rojoProjectPath: at("default.project.json"),
	});
	return resolve(at(file), call);
}

describe(createRojoRequireResolver, () => {
	it("should resolve a script-relative instance path", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: {
				kind: "instance",
				path: {
					root: "script",
					segments: [{ kind: "parent" }, { name: "sibling", kind: "child" }],
				},
			},
			file: "out/main.luau",
		});

		expect(resolved).toBe(at("out/sibling.luau"));
	});

	it("should resolve a folder to its init module", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: {
				kind: "instance",
				path: { root: "script", segments: [{ kind: "parent" }] },
			},
			file: "out/feature/part.luau",
		});

		expect(resolved).toBe(at("out/feature/init.luau"));
	});

	it("should resolve a game:GetService path", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: {
				kind: "instance",
				path: {
					root: "game",
					segments: [
						{ name: "ReplicatedStorage", kind: "child" },
						{ name: "shared", kind: "child" },
						{ name: "feature", kind: "child" },
						{ name: "part", kind: "child" },
					],
				},
			},
			file: "out/main.luau",
		});

		expect(resolved).toBe(at("out/feature/part.luau"));
	});

	it("should resolve a TS.import from its base and child names", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: {
				base: { root: "script", segments: [{ kind: "parent" }] },
				kind: "ts-import",
				segments: ["feature", "part"],
			},
			file: "out/main.luau",
		});

		expect(resolved).toBe(at("out/feature/part.luau"));
	});

	it("should resolve a TS.getModule package through the nearest node_modules", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: {
				kind: "ts-package",
				segments: ["@rbxts", "pkg", "src"],
			},
			file: "out/main.luau",
		});

		expect(resolved).toBe(at("node_modules/@rbxts/pkg/src/init.lua"));
	});

	it("should read a TS.getModule package with no scope as an @rbxts one", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: {
				kind: "ts-package",
				segments: ["pkg", "src"],
			},
			file: "out/main.luau",
		});

		expect(resolved).toBe(at("node_modules/@rbxts/pkg/src/init.lua"));
	});

	it("should leave a path above the DataModel unresolved", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: {
				kind: "instance",
				path: {
					root: "script",
					segments: [
						{ kind: "parent" },
						{ kind: "parent" },
						{ kind: "parent" },
						{ kind: "parent" },
						{ name: "ReplicatedStorage", kind: "child" },
						{ name: "shared", kind: "child" },
						{ name: "sibling", kind: "child" },
					],
				},
			},
			file: "out/main.luau",
		});

		expect(resolved).toBeUndefined();
	});

	it("should leave a path with no module unresolved", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: {
				kind: "instance",
				path: {
					root: "script",
					segments: [{ kind: "parent" }, { name: "missing", kind: "child" }],
				},
			},
			file: "out/main.luau",
		});

		expect(resolved).toBeUndefined();
	});

	it("should leave a script path from a file outside the Rojo tree unresolved", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: {
				kind: "instance",
				path: { root: "script", segments: [{ kind: "parent" }] },
			},
			file: "elsewhere.luau",
		});

		expect(resolved).toBeUndefined();
	});

	it("should resolve a Lua file the project mounts on its own", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: {
				kind: "instance",
				path: {
					root: "game",
					segments: [
						{ name: "ReplicatedStorage", kind: "child" },
						{ name: "RuntimeLib", kind: "child" },
					],
				},
			},
			file: "out/main.luau",
			files: { "include/RuntimeLib.lua": "return {}" },
			project: JSON.stringify({
				name: "game",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						RuntimeLib: { $path: "include/RuntimeLib.lua" },
						shared: { $path: "out" },
					},
				},
			}),
		});

		expect(resolved).toBe(at("include/RuntimeLib.lua"));
	});

	it("should skip a mount with nothing on disk", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: SIBLING,
			file: "out/main.luau",
			project: JSON.stringify({
				name: "game",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { missing: { $path: "missing" }, shared: { $path: "out" } },
				},
			}),
		});

		expect(resolved).toBe(at("out/sibling.luau"));
	});

	it("should leave a TS.import from a file outside the Rojo tree unresolved", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: {
				base: { root: "script", segments: [{ kind: "parent" }] },
				kind: "ts-import",
				segments: ["sibling"],
			},
			file: "elsewhere.luau",
		});

		expect(resolved).toBeUndefined();
	});

	it("should leave a package from a file outside the Rojo tree unresolved", () => {
		expect.assertions(1);

		expect(resolveFrom({ call: PACKAGE_MODULE, file: "elsewhere.luau" })).toBeUndefined();
	});

	it("should leave a package no node_modules holds unresolved", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: {
				kind: "ts-package",
				segments: ["@rbxts", "absent"],
			},
			file: "out/main.luau",
		});

		expect(resolved).toBeUndefined();
	});

	it("should resolve only Luau modules", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: {
				kind: "instance",
				path: {
					root: "script",
					segments: [{ kind: "parent" }, { name: "data", kind: "child" }],
				},
			},
			file: "out/main.luau",
			files: { "out/data.json": "{}" },
		});

		expect(resolved).toBeUndefined();
	});

	it("should find a package in a node_modules at the root of the tree", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: PACKAGE_MODULE,
			file: "out/main.luau",
			project: JSON.stringify({
				name: "library",
				tree: {
					$className: "Folder",
					node_modules: { "@rbxts": { $path: "node_modules/@rbxts" } },
					out: { $path: "out" },
				},
			}),
		});

		expect(resolved).toBe(at("node_modules/@rbxts/pkg/src/init.lua"));
	});

	it("should follow a linked package folder", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: { kind: "ts-package", segments: ["@rbxts", "linked", "src"] },
			file: "out/main.luau",
			files: { "packages/linked/src/init.luau": "return {}" },
			links: { "node_modules/@rbxts/linked": "packages/linked" },
		});

		expect(resolved).toBe(at("node_modules/@rbxts/linked/src/init.luau"));
	});

	it("should list a module reached only through a linked file", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: {
				kind: "instance",
				path: {
					root: "script",
					segments: [{ kind: "parent" }, { name: "linked", kind: "child" }],
				},
			},
			file: "out/main.luau",
			files: { "elsewhere/source.luau": "return {}" },
			links: { "out/linked.luau": "elsewhere/source.luau" },
		});

		expect(resolved).toBe(at("out/linked.luau"));
	});

	it("should not list a linked file that is not Luau", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: {
				kind: "instance",
				path: {
					root: "script",
					segments: [{ kind: "parent" }, { name: "linked", kind: "child" }],
				},
			},
			file: "out/main.luau",
			files: { "elsewhere/source.json": "{}" },
			links: { "out/linked.json": "elsewhere/source.json" },
		});

		expect(resolved).toBeUndefined();
	});

	it("should not list a link with nothing at its target", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: {
				kind: "instance",
				path: {
					root: "script",
					segments: [{ kind: "parent" }, { name: "dangling", kind: "child" }],
				},
			},
			file: "out/main.luau",
			links: { "out/dangling.luau": "missing.luau" },
		});

		expect(resolved).toBeUndefined();
	});

	it("should not list a mounted Luau file with nothing on disk", () => {
		expect.assertions(1);

		const resolved = resolveFrom({
			call: {
				kind: "instance",
				path: {
					root: "game",
					segments: [
						{ name: "ReplicatedStorage", kind: "child" },
						{ name: "Gone", kind: "child" },
					],
				},
			},
			file: "out/main.luau",
			project: JSON.stringify({
				name: "game",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						Gone: { $path: "include/Gone.luau" },
						shared: { $path: "out" },
					},
				},
			}),
		});

		expect(resolved).toBeUndefined();
	});
});
