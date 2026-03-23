import { RojoResolver } from "@roblox-ts/rojo-resolver";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSetupResolver } from "./setup-resolver.ts";

vi.mock(import("@roblox-ts/rojo-resolver"));

const configDirectory = "/project";
const rojoConfigPath = "/project/default.project.json";

function mockRojoResolver(mapping: Record<string, Array<string>>) {
	vi.mocked(RojoResolver.fromPath).mockReturnValue({
		getRbxPathFromFilePath(filePath: string) {
			return mapping[filePath];
		},
	} as unknown as RojoResolver);
}

function makeResolver(overrides: Partial<Parameters<typeof createSetupResolver>[0]> = {}) {
	return createSetupResolver({
		configDirectory,
		rojoConfigPath,
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

/** Build the absolute logical path that the resolver constructs for package specifiers */
function logicalNodeModulesPath(specifier: string): string {
	return path.resolve(configDirectory, "node_modules", specifier);
}

describe(createSetupResolver, () => {
	describe("relative paths", () => {
		it("should resolve a relative path with .ts extension", () => {
			expect.assertions(1);

			mockRojoResolver({
				[path.resolve(configDirectory, "./src/client/test-setup.ts")]: [
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

			mockRojoResolver({
				[path.resolve(configDirectory, "./src/client/test-setup")]: [
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
			mockRojoResolver({
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

			mockRojoResolver({
				[path.resolve(configDirectory, "./src/server/bootstrap")]: [
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

			mockRojoResolver({});
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

			mockRojoResolver({
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

			mockRojoResolver({
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

			mockRojoResolver({});
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

			mockRojoResolver({});
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
