import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { FileSystem } from "../utils/file-system.ts";
import {
	requireRojoProject,
	resolveLayoutProject,
	resolveRojoProject,
	withRojoProject,
} from "./rojo-project.ts";

const ROOT = path.resolve("/repo");
const LAYOUT_PATH = path.join("/repo/pkg", ".jest-roblox-layout.project.json");

function seedProject(fileSystem: FileSystem, fileName = "default.project.json"): void {
	fileSystem.mkdirSync(ROOT, { recursive: true });
	fileSystem.writeFileSync(path.join(ROOT, "tsconfig.json"), "{}");
	fileSystem.writeFileSync(path.join(ROOT, fileName), "{}");
}

function luauPackage(extra: Record<string, string> = {}) {
	return createMemoryFileSystem(
		{
			"/repo/pkg/.jest-roblox/cache/stub.luau": "",
			"/repo/pkg/node_modules/@rbxts-js/jest/init.luau": "",
			"/repo/pkg/README.md": "",
			"/repo/pkg/src/init.luau": "return {}",
			"/repo/pkg/test/greet.spec.luau": "",
			...extra,
		},
		"/",
	);
}

function resolvePackage(fileSystem: FileSystem): string | undefined {
	return resolveRojoProject({ config: { rootDir: "/repo/pkg" }, fileSystem });
}

function readLayout(volume: ReturnType<typeof luauPackage>["volume"]) {
	return JSON.parse(volume.readFileSync(LAYOUT_PATH, "utf-8").toString());
}

describe(resolveRojoProject, () => {
	it("should prefer default.project.json over other project files", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		seedProject(fileSystem, "custom.project.json");

		seedProject(fileSystem);

		expect(resolveRojoProject({ config: { rootDir: ROOT }, fileSystem })).toBe(
			path.join(ROOT, "default.project.json"),
		);
	});

	it("should find an alternate project file but reject similar suffixes", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		fileSystem.mkdirSync(ROOT, { recursive: true });

		fileSystem.writeFileSync(path.join(ROOT, "ignored.project.json.bak"), "{}");
		seedProject(fileSystem, "custom.project.json");

		expect(resolveRojoProject({ config: { rootDir: ROOT }, fileSystem })).toBe(
			path.join(ROOT, "custom.project.json"),
		);
	});

	it("should return undefined when no project file exists", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		fileSystem.mkdirSync(ROOT, { recursive: true });
		fileSystem.writeFileSync(path.join(ROOT, "tsconfig.json"), "{}");

		expect(resolveRojoProject({ config: { rootDir: ROOT }, fileSystem })).toBeUndefined();
	});

	it("should resolve a configured project against rootDir", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(
			resolveRojoProject({
				config: { rojoProject: "build/game.project.json", rootDir: ROOT },
				fileSystem,
			}),
		).toBe(path.join(ROOT, "build", "game.project.json"));
	});

	it("should keep an absolute configured project as written", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const absolute = path.resolve("/elsewhere/game.project.json");

		expect(
			resolveRojoProject({ config: { rojoProject: absolute, rootDir: ROOT }, fileSystem }),
		).toBe(absolute);
	});

	it("should point rojoProject at a project built from the file layout", () => {
		expect.assertions(2);

		const { fileSystem, volume } = luauPackage();

		const rojoProject = resolvePackage(fileSystem);

		expect(rojoProject).toBe(LAYOUT_PATH);
		expect(readLayout(volume)).toStrictEqual({
			name: "pkg",
			tree: {
				$className: "DataModel",
				ReplicatedStorage: {
					$className: "ReplicatedStorage",
					pkg: {
						$className: "Folder",
						src: { $path: "src" },
						test: { $path: "test" },
					},
				},
				ServerScriptService: {
					$className: "ServerScriptService",
					$properties: { LoadStringEnabled: true },
				},
				Workspace: {
					$className: "Workspace",
					$properties: { SignalBehavior: "Deferred" },
				},
			},
		});
	});

	it("should mount the nearest generated @rbxts-js project as node_modules", () => {
		expect.assertions(1);

		const { fileSystem, volume } = luauPackage({
			"/repo/node_modules/@rbxts-js.project.json": "{}",
		});

		resolvePackage(fileSystem);

		expect(readLayout(volume)).toMatchObject({
			tree: {
				ReplicatedStorage: {
					node_modules: {
						"$className": "Folder",
						"@rbxts-js": {
							$className: "Folder",
							$path: "../node_modules/@rbxts-js.project.json",
						},
					},
				},
			},
		});
	});

	it("should use a package's own Rojo project, test.project.json included", () => {
		expect.assertions(2);

		const { fileSystem, volume } = luauPackage({ "/repo/pkg/test.project.json": "{}" });

		const rojoProject = resolvePackage(fileSystem);

		expect(rojoProject).toBe(path.join("/repo/pkg", "test.project.json"));
		expect(volume.existsSync(LAYOUT_PATH)).toBeFalse();
	});

	it("should take a configured rojoProject over the file layout", () => {
		expect.assertions(2);

		const { fileSystem, volume } = luauPackage();

		const rojoProject = resolveRojoProject({
			config: { rojoProject: "custom.project.json", rootDir: "/repo/pkg" },
			fileSystem,
		});

		expect(rojoProject).toBe(path.resolve("/repo/pkg", "custom.project.json"));
		expect(volume.existsSync(LAYOUT_PATH)).toBeFalse();
	});

	it("should leave a roblox-ts package alone", () => {
		expect.assertions(1);

		const { fileSystem } = luauPackage({ "/repo/pkg/tsconfig.json": "{}" });

		const rojoProject = resolvePackage(fileSystem);

		expect(rojoProject).toBeUndefined();
	});

	it("should rebuild a layout project left by an earlier run", () => {
		expect.assertions(1);

		const { fileSystem, volume } = luauPackage({ [LAYOUT_PATH]: "{}" });

		resolvePackage(fileSystem);

		expect(readLayout(volume)).toMatchObject({ name: "pkg" });
	});

	it("should take the default file as configured when the config names none", () => {
		expect.assertions(1);

		const { fileSystem } = luauPackage({ "/repo/pkg/default.project.json": "{}" });

		expect(
			resolveRojoProject({
				config: { rootDir: "/repo/pkg" },
				defaultFile: "test.project.json",
				fileSystem,
			}),
		).toBe(path.resolve("/repo/pkg", "test.project.json"));
	});

	it("should find nothing under a rootDir that does not exist", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(resolveRojoProject({ config: { rootDir: ROOT }, fileSystem })).toBeUndefined();
	});
});

describe(withRojoProject, () => {
	it("should settle rojoProject on the config and keep its other fields", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		seedProject(fileSystem);

		expect(withRojoProject({ rootDir: ROOT, testTimeout: 5 }, fileSystem)).toStrictEqual({
			rojoProject: path.join(ROOT, "default.project.json"),
			rootDir: ROOT,
			testTimeout: 5,
		});
	});
});

describe(resolveLayoutProject, () => {
	it("should point a Luau-only package at its layout project", () => {
		expect.assertions(1);

		const { fileSystem } = luauPackage();

		expect(
			resolveLayoutProject({
				config: { ...createResolvedConfig(), rootDir: "/repo/pkg" },
				fileSystem,
			}).rojoProject,
		).toBe(LAYOUT_PATH);
	});
});

describe(requireRojoProject, () => {
	it("should return a settled project and refuse a config without one", () => {
		expect.assertions(2);

		expect(requireRojoProject({ rojoProject: "/repo/a.project.json" })).toBe(
			"/repo/a.project.json",
		);
		expect(() => requireRojoProject({})).toThrow("No Rojo project found");
	});
});
