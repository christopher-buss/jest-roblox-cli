import { fromAny } from "@total-typescript/shoehorn";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { RojoResolverFactory } from "../utils/rojo-project-reader.ts";
import { createRojoResolverCache, createSetupResolver } from "./setup-resolver.ts";

const CONFIG_DIRECTORY = "/project";
const ROJO_CONFIG_PATH = "/project/default.project.json";

const createResolver = vi.fn<RojoResolverFactory>();

function stubRojoResolver(mapping: Record<string, Array<string>>) {
	createResolver.mockReturnValue(
		fromAny({
			getRbxPathFromFilePath(filePath: string) {
				return mapping[filePath];
			},
		}),
	);
}

function makeResolver(overrides: Partial<Parameters<typeof createSetupResolver>[0]> = {}) {
	return createSetupResolver({
		configDirectory: CONFIG_DIRECTORY,
		createResolver,
		rojoConfigPath: ROJO_CONFIG_PATH,
		...overrides,
	});
}

function fakeModuleResolver(mapping: Record<string, string>) {
	return (specifier: string): string => {
		const resolved = mapping[specifier];
		if (resolved === undefined) {
			throw new Error(`Cannot find module '${specifier}'`);
		}

		return resolved;
	};
}

/**
 * Build the absolute logical path that the resolver constructs for package
 * specifiers
 */
function logicalNodeModulesPath(specifier: string): string {
	return path.resolve(CONFIG_DIRECTORY, "node_modules", specifier);
}

function writeRealProject(files: Record<string, string>): string {
	const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "setup-resolver-")));
	onTestFinished(() => {
		fs.rmSync(directory, { force: true, recursive: true });
	});

	for (const [relativePath, contents] of Object.entries(files)) {
		const full = path.join(directory, relativePath);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, contents);
	}

	return directory;
}

describe(createSetupResolver, () => {
	describe("relative paths", () => {
		it("should resolve a relative path with .ts extension", () => {
			expect.assertions(1);

			stubRojoResolver({
				[path.resolve(CONFIG_DIRECTORY, "./src/client/test-setup.ts")]: [
					"ReplicatedStorage",
					"client",
					"test-setup",
				],
			});
			const resolve = makeResolver();

			const result = resolve("./src/client/test-setup.ts");

			expect(result).toBe("ReplicatedStorage/client/test-setup");
		});

		it("should resolve a relative path without extension", () => {
			expect.assertions(1);

			stubRojoResolver({
				[path.resolve(CONFIG_DIRECTORY, "./src/client/test-setup")]: [
					"ReplicatedStorage",
					"client",
					"test-setup",
				],
			});
			const resolve = makeResolver();

			const result = resolve("./src/client/test-setup");

			expect(result).toBe("ReplicatedStorage/client/test-setup");
		});

		it("should resolve ../ relative paths", () => {
			expect.assertions(1);

			const nestedConfigDirectory = "/project/config";
			stubRojoResolver({
				[path.resolve(nestedConfigDirectory, "../src/client/test-setup")]: [
					"ReplicatedStorage",
					"client",
					"test-setup",
				],
			});
			const resolve = makeResolver({ configDirectory: nestedConfigDirectory });

			const result = resolve("../src/client/test-setup");

			expect(result).toBe("ReplicatedStorage/client/test-setup");
		});

		it("should resolve paths in server directory", () => {
			expect.assertions(1);

			stubRojoResolver({
				[path.resolve(CONFIG_DIRECTORY, "./src/server/bootstrap")]: [
					"ServerScriptService",
					"server",
					"bootstrap",
				],
			});
			const resolve = makeResolver();

			const result = resolve("./src/server/bootstrap");

			expect(result).toBe("ServerScriptService/server/bootstrap");
		});

		it("should throw when relative path has no rojo tree match", () => {
			expect.assertions(1);

			stubRojoResolver({});
			const resolve = makeResolver();

			expect(() => resolve("./src/unknown/test-setup")).toThrowWithMessage(
				Error,
				/no matching path found in rojo project tree/i,
			);
		});
	});

	describe("package specifiers", () => {
		it("should resolve packages relative to the config directory by default", () => {
			expect.assertions(1);

			const directory = writeRealProject({
				"node_modules/example/package.json": JSON.stringify({ main: "setup.luau" }),
				"node_modules/example/setup.luau": "return {}",
			});
			stubRojoResolver({
				[path.resolve(directory, "node_modules", "example")]: [
					"ReplicatedStorage",
					"example",
				],
			});
			const resolve = createSetupResolver({
				configDirectory: directory,
				createResolver,
				rojoConfigPath: path.join(directory, "default.project.json"),
			});

			expect(resolve("example")).toBe("ReplicatedStorage/example");
		});

		it("should resolve a scoped package specifier", () => {
			expect.assertions(1);

			stubRojoResolver({
				[logicalNodeModulesPath("@rbxts/test-utils/out/setup")]: [
					"ReplicatedStorage",
					"rbxts_include",
					"node_modules",
					"@rbxts",
					"test-utils",
					"setup",
				],
			});
			const resolve = makeResolver({
				resolveModule: fakeModuleResolver({
					"@rbxts/test-utils/out/setup": "/resolved/path/irrelevant.lua",
				}),
			});

			const result = resolve("@rbxts/test-utils/out/setup");

			expect(result).toBe(
				"ReplicatedStorage/rbxts_include/node_modules/@rbxts/test-utils/setup",
			);
		});

		it("should resolve package specifier with extension probing", () => {
			expect.assertions(1);

			stubRojoResolver({
				[logicalNodeModulesPath("@shared/test-utils/out/setup")]: [
					"ReplicatedStorage",
					"rbxts_include",
					"node_modules",
					"@shared",
					"test-utils",
					"setup",
				],
			});
			const resolve = makeResolver({
				resolveModule: fakeModuleResolver({
					"@shared/test-utils/out/setup.luau": "/resolved/path/irrelevant.luau",
				}),
			});

			const result = resolve("@shared/test-utils/out/setup");

			expect(result).toBe(
				"ReplicatedStorage/rbxts_include/node_modules/@shared/test-utils/setup",
			);
		});

		it("should throw when package cannot be resolved", () => {
			expect.assertions(1);

			stubRojoResolver({});
			const resolve = makeResolver({
				resolveModule: fakeModuleResolver({}),
			});

			expect(() => resolve("@nonexistent/pkg/setup")).toThrowWithMessage(
				Error,
				/could not resolve module/i,
			);
		});

		it("should throw when resolved package path has no rojo tree match", () => {
			expect.assertions(1);

			stubRojoResolver({});
			const resolve = makeResolver({
				resolveModule: fakeModuleResolver({
					"@some/unknown-pkg/setup": "/resolved/path/irrelevant.lua",
				}),
			});

			expect(() => resolve("@some/unknown-pkg/setup")).toThrowWithMessage(
				Error,
				/no matching path found in rojo project tree/i,
			);
		});
	});

	it("should walk the real rojo project when no factory is given", () => {
		expect.assertions(1);

		const directory = writeRealProject({
			"default.project.json": JSON.stringify({
				name: "Game",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { $path: "src" },
				},
			}),
			"src/test-setup.luau": "return {}",
		});

		const resolve = createSetupResolver({
			configDirectory: directory,
			rojoConfigPath: path.join(directory, "default.project.json"),
		});

		expect(resolve("./src/test-setup.luau")).toBe("ReplicatedStorage/test-setup");
	});
});

describe("resolver caching", () => {
	it("should build one resolver per rojo config path when a cache is shared", () => {
		expect.assertions(3);

		stubRojoResolver({
			[path.resolve(CONFIG_DIRECTORY, "./setup.luau")]: ["ReplicatedStorage", "setup"],
		});
		const cache = createRojoResolverCache();

		const first = makeResolver({ cache });
		const second = makeResolver({ cache });

		expect(createResolver).toHaveBeenCalledOnce();
		expect(first("./setup.luau")).toBe("ReplicatedStorage/setup");
		expect(second("./setup.luau")).toBe("ReplicatedStorage/setup");
	});

	it("should build a resolver per call when no cache is given", () => {
		expect.assertions(1);

		stubRojoResolver({});

		makeResolver();
		makeResolver();

		expect(createResolver).toHaveBeenCalledTimes(2);
	});

	it("should key the cache by rojo config path", () => {
		expect.assertions(1);

		stubRojoResolver({});
		const cache = createRojoResolverCache();

		makeResolver({ cache });
		makeResolver({ cache, rojoConfigPath: "/project/other.project.json" });

		expect(createResolver).toHaveBeenCalledTimes(2);
	});
});
