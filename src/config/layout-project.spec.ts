import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { LAYOUT_PROJECT_FILE, resolveLayoutProject } from "./layout-project.ts";
import { DEFAULT_CONFIG, type ResolvedConfig } from "./schema.ts";

const LAYOUT_PATH = path.join("/repo/pkg", LAYOUT_PROJECT_FILE);

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

function packageConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...DEFAULT_CONFIG, rootDir: "/repo/pkg", ...overrides };
}

function readLayout(volume: ReturnType<typeof luauPackage>["volume"]) {
	return JSON.parse(volume.readFileSync(LAYOUT_PATH, "utf-8").toString());
}

describe(resolveLayoutProject, () => {
	it("should point rojoProject at a project built from the file layout", () => {
		expect.assertions(2);

		const { fileSystem, volume } = luauPackage();

		const config = resolveLayoutProject({ config: packageConfig(), fileSystem });

		expect(config.rojoProject).toBe(path.join("/repo/pkg", LAYOUT_PROJECT_FILE));
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

		resolveLayoutProject({ config: packageConfig(), fileSystem });

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

	it("should leave a package with its own Rojo project alone", () => {
		expect.assertions(2);

		const { fileSystem, volume } = luauPackage({ "/repo/pkg/test.project.json": "{}" });

		const config = resolveLayoutProject({ config: packageConfig(), fileSystem });

		expect(config.rojoProject).toBeUndefined();
		expect(volume.existsSync(LAYOUT_PATH)).toBeFalse();
	});

	it("should leave a configured rojoProject alone", () => {
		expect.assertions(1);

		const { fileSystem } = luauPackage();

		const config = resolveLayoutProject({
			config: packageConfig({ rojoProject: "custom.project.json" }),
			fileSystem,
		});

		expect(config.rojoProject).toBe("custom.project.json");
	});

	it("should leave a roblox-ts package alone", () => {
		expect.assertions(1);

		const { fileSystem } = luauPackage({ "/repo/pkg/tsconfig.json": "{}" });

		const config = resolveLayoutProject({ config: packageConfig(), fileSystem });

		expect(config.rojoProject).toBeUndefined();
	});

	it("should rebuild a layout project left by an earlier run", () => {
		expect.assertions(1);

		const { fileSystem, volume } = luauPackage({ [LAYOUT_PATH]: "{}" });

		resolveLayoutProject({ config: packageConfig(), fileSystem });

		expect(readLayout(volume)).toMatchObject({ name: "pkg" });
	});
});
