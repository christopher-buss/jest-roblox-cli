import type { RojoResolver } from "@isentinel/rojo-utils";
import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedConfig } from "./resolved-config.ts";
import { createSetupResolver, resolveAllSetupFilePaths } from "./setup-resolver.ts";

const CONFIG_DIRECTORY = "/project";
const ROJO_CONFIG_PATH = "/project/default.project.json";

const createResolver = vi.fn<typeof RojoResolver.fromPath>();

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
 * specifiers.
 *
 * @param specifier - Package specifier.
 * @returns The path under the config directory's `node_modules`.
 */
function logicalNodeModulesPath(specifier: string): string {
	return path.resolve(CONFIG_DIRECTORY, "node_modules", specifier);
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
});

describe("resolver caching", () => {
	it("should build one resolver per rojo config path when a cache is shared", () => {
		expect.assertions(3);

		stubRojoResolver({
			[path.resolve(CONFIG_DIRECTORY, "./setup.luau")]: ["ReplicatedStorage", "setup"],
		});
		const cache = new Map<string, RojoResolver>();

		const first = makeResolver({ cache });
		const second = makeResolver({ cache });

		expect(createResolver).toHaveBeenCalledExactlyOnceWith(ROJO_CONFIG_PATH);
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
		const cache = new Map<string, RojoResolver>();

		makeResolver({ cache });
		makeResolver({ cache, rojoConfigPath: "/project/other.project.json" });

		expect(createResolver).toHaveBeenCalledTimes(2);
	});
});

describe("native resolver", () => {
	it("should resolve a committed project through the default factory", () => {
		expect.assertions(1);

		const directory = path.resolve(import.meta.dirname, "../../test/fixtures/setup-resolver");
		const resolve = createSetupResolver({
			configDirectory: directory,
			rojoConfigPath: path.join(directory, "default.project.json"),
		});

		expect(resolve("./test-setup.luau")).toBe("ReplicatedStorage");
	});
});

describe("native package resolver", () => {
	it("should resolve packages relative to the config directory by default", () => {
		expect.assertions(1);

		const directory = path.resolve(import.meta.dirname, "../../test/e2e/fixtures/live-place");
		stubRojoResolver({
			[path.join(directory, "node_modules", "@rbxts/jest-globals")]: [
				"ReplicatedStorage",
				"@rbxts/jest-globals",
			],
		});
		const resolve = createSetupResolver({
			configDirectory: directory,
			createResolver,
			rojoConfigPath: path.join(directory, "default.project.json"),
		});

		expect(resolve("@rbxts/jest-globals")).toBe("ReplicatedStorage/@rbxts/jest-globals");
	});
});

describe(resolveAllSetupFilePaths, () => {
	function setupConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
		return { ...createResolvedConfig(), rootDir: CONFIG_DIRECTORY, ...overrides };
	}

	function resolveAll(
		configs: Array<ResolvedConfig>,
		rojoConfigPathOf: (config: ResolvedConfig) => string = () => ROJO_CONFIG_PATH,
	) {
		const factory = vi.fn<typeof createSetupResolver>(() => {
			return (input) => `Resolved/${path.basename(input)}`;
		});
		resolveAllSetupFilePaths({
			configs,
			createSetupResolver: factory,
			sourceOf: (config) => {
				return {
					configDirectory: config.rootDir,
					rojoConfigPath: rojoConfigPathOf(config),
				};
			},
		});
		return factory.mock.calls.map(([options]) => {
			return {
				configDirectory: options.configDirectory,
				rojoConfigPath: options.rojoConfigPath,
			};
		});
	}

	it("should build no resolver when no config declares setup files", () => {
		expect.assertions(1);

		expect(resolveAll([setupConfig(), setupConfig()])).toStrictEqual([]);
	});

	it("should rewrite both setup lists of every config that declares them", () => {
		expect.assertions(2);

		const empty = setupConfig();
		const before = setupConfig({ setupFiles: ["./a.ts"] });
		const after = setupConfig({ setupFilesAfterEnv: ["./b.ts"] });

		const sources = resolveAll([empty, before, after]);

		expect([empty.setupFiles, before.setupFiles, after.setupFilesAfterEnv]).toStrictEqual([
			undefined,
			["Resolved/a.ts"],
			["Resolved/b.ts"],
		]);
		expect(sources).toStrictEqual([
			{ configDirectory: CONFIG_DIRECTORY, rojoConfigPath: ROJO_CONFIG_PATH },
		]);
	});

	it("should build one resolver per distinct source", () => {
		expect.assertions(1);

		const one = setupConfig({ rojoProject: "one.project.json", setupFiles: ["./a.ts"] });
		const two = setupConfig({
			rojoProject: "two.project.json",
			rootDir: "/other",
			setupFiles: ["./b.ts"],
		});
		const three = setupConfig({
			rojoProject: "one.project.json",
			rootDir: "/other",
			setupFiles: ["./c.ts"],
		});

		expect(resolveAll([one, two, three], (config) => config.rojoProject!)).toStrictEqual([
			{ configDirectory: CONFIG_DIRECTORY, rojoConfigPath: "one.project.json" },
			{ configDirectory: "/other", rojoConfigPath: "two.project.json" },
			{ configDirectory: "/other", rojoConfigPath: "one.project.json" },
		]);
	});
});
