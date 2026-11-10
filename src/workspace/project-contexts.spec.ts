import * as path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import { createLuteChildProcess } from "#test/mocks/lute-child-process.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { SetupResolverFactory } from "../config/setup-resolver.ts";
import type { TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import type { LoadedPackage } from "./package-loader.ts";
import { resolvePackageContextsAsync } from "./project-contexts.ts";

const PACKAGE_DIRECTORY = path.resolve("/repo/packages/pkg");
const ROJO_PROJECT_PATH = path.join(PACKAGE_DIRECTORY, "test.project.json");
const CACHE_DIRECTORY = path.resolve("/repo/.jest-roblox/workspace");

function rojoProject(mountPath: string): string {
	return JSON.stringify({
		name: "pkg",
		tree: { $className: "DataModel", ReplicatedStorage: { Pkg: { $path: mountPath } } },
	});
}

function unusedResolver(): SetupResolverFactory {
	return vi.fn<SetupResolverFactory>(() => {
		throw new Error("unexpected createSetupResolver call");
	});
}

function noTsconfig(): TsconfigReader {
	return vi.fn<TsconfigReader>(() => null);
}

function loadedPackage(overrides: Partial<ResolvedConfig>): LoadedPackage {
	return {
		descriptor: {
			name: "@halcyon/pkg",
			packageDirectory: PACKAGE_DIRECTORY,
			rojoProjectPath: ROJO_PROJECT_PATH,
		},
		info: { name: "@halcyon/pkg", packageDirectory: PACKAGE_DIRECTORY },
		pkgConfig: {
			...createResolvedConfig(),
			rojoProject: ROJO_PROJECT_PATH,
			rootDir: PACKAGE_DIRECTORY,
			...overrides,
		},
	};
}

describe(resolvePackageContextsAsync, () => {
	it("should synthesize one project from only the directory mounts in the Rojo tree", async () => {
		expect.assertions(5);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(PACKAGE_DIRECTORY, "src/shared/pkg.spec.luau")]: "",
			[path.join(PACKAGE_DIRECTORY, "src/source.luau")]: "",
			[ROJO_PROJECT_PATH]: JSON.stringify({
				name: "pkg",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						Shared: { $path: "src/shared" },
						Source: { $path: "src/source.luau" },
					},
				},
			}),
		});

		const contexts = await resolvePackageContextsAsync({
			cacheDirectory: CACHE_DIRECTORY,
			childProcess: createLuteChildProcess({ version: "1.0.1" }),
			createSetupResolver: unusedResolver(),
			fileSystem,
			loaded: [
				loadedPackage({
					projects: [],
					rojoProject: undefined,
					testMatch: ["**/*.spec.ts", "**/*.spec-d.ts", "**/*.spec-d.luau"],
				}),
			],
			tsconfigReader: noTsconfig(),
		});
		const context = contexts[0];
		assert(context !== undefined);
		const { projects } = context;
		const firstProject = projects[0];
		assert(firstProject !== undefined);

		expect(projects).toHaveLength(1);
		expect(firstProject.include).toStrictEqual(["**/*.spec.ts"]);
		expect(firstProject.displayName).toBe("pkg");
		expect(firstProject.projects).toStrictEqual(["ReplicatedStorage/Shared"]);
		expect(firstProject.typecheck!.include).toStrictEqual([
			"**/*.spec-d.ts",
			"**/*.spec-d.luau",
		]);
	});

	it("should reject an implicit project whose roots have no Rojo mount", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ [ROJO_PROJECT_PATH]: rojoProject("src") });

		await expect(
			resolvePackageContextsAsync({
				cacheDirectory: CACHE_DIRECTORY,
				childProcess: createLuteChildProcess({ version: "1.0.1" }),
				createSetupResolver: unusedResolver(),
				fileSystem,
				loaded: [loadedPackage({ luauRoots: ["unmounted"] })],
				tsconfigReader: noTsconfig(),
			}),
		).rejects.toThrow("No test projects could be derived");
	});

	it("should read a project's jest.config.luau through the injected filesystem", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(PACKAGE_DIRECTORY, "src/shared/jest.config.luau")]:
				'return { displayName = "shared-luau" }',
			[ROJO_PROJECT_PATH]: rojoProject("src/shared"),
		});

		const contexts = await resolvePackageContextsAsync({
			cacheDirectory: CACHE_DIRECTORY,
			childProcess: createLuteChildProcess({ version: "1.0.1" }),
			createSetupResolver: unusedResolver(),
			fileSystem,
			loaded: [loadedPackage({ projects: ["src/shared"] })],
			tsconfigReader: noTsconfig(),
		});

		const project = contexts[0]!.projects[0]!;

		expect(project.displayName).toBe("shared-luau");
		expect(project.include).toStrictEqual(["src/shared/**/*.spec.luau"]);
	});

	it("should run a project's jest.config.luau that holds code through the injected runner", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(PACKAGE_DIRECTORY, "src/shared/jest.config.luau")]:
				'return { displayName = "shared" .. "-luau" }',
			[ROJO_PROJECT_PATH]: rojoProject("src/shared"),
		});

		await expect(
			resolvePackageContextsAsync({
				cacheDirectory: CACHE_DIRECTORY,
				childProcess: createLuteChildProcess({ version: "9.9.9" }),
				createSetupResolver: unusedResolver(),
				fileSystem,
				loaded: [loadedPackage({ projects: ["src/shared"] })],
				tsconfigReader: noTsconfig(),
			}),
		).rejects.toThrow('--version" printed "9.9.9"');
	});

	it("should build the setup resolver through the injected factory", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(PACKAGE_DIRECTORY, "src/pkg.spec.luau")]: "",
			[path.join(PACKAGE_DIRECTORY, "src/setup.luau")]: "",
			[ROJO_PROJECT_PATH]: rojoProject("src"),
		});

		const createSetupResolver = vi
			.fn<SetupResolverFactory>()
			.mockReturnValue(() => "ReplicatedStorage/Pkg/setup");

		const contexts = await resolvePackageContextsAsync({
			cacheDirectory: CACHE_DIRECTORY,
			childProcess: createLuteChildProcess({ version: "1.0.1" }),
			createSetupResolver,
			fileSystem,
			loaded: [
				loadedPackage({
					projects: [
						{
							test: {
								displayName: "with-setup",
								include: ["src/**/*.spec.luau"],
								setupFiles: ["./src/setup.luau"],
							},
						},
						{
							test: {
								displayName: "without-setup",
								include: ["src/**/*.spec.luau"],
							},
						},
					],
				}),
			],
			tsconfigReader: noTsconfig(),
		});

		expect(createSetupResolver).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				configDirectory: PACKAGE_DIRECTORY,
				rojoConfigPath: ROJO_PROJECT_PATH,
			}),
		);
		expect(contexts[0]!.projects[0]!.config.setupFiles).toStrictEqual([
			"ReplicatedStorage/Pkg/setup",
		]);
	});
});
