import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { RojoResolverFactory } from "../utils/rojo-project-reader.ts";
import type { LoadedPackage } from "./package-loader.ts";
import {
	applyProjectFilter,
	type PackageContext,
	resolvePackageContextsAsync,
} from "./project-contexts.ts";

const PACKAGE_DIRECTORY = path.resolve("/repo/packages/pkg");
const ROJO_PROJECT_PATH = path.join(PACKAGE_DIRECTORY, "test.project.json");
const CACHE_DIRECTORY = path.resolve("/repo/.jest-roblox/workspace");

function makeProject(displayName: string): ResolvedProjectConfig {
	return fromAny({ displayName });
}

function makeContext(name: string, projects: Array<string>): PackageContext {
	return fromAny({
		info: { name },
		projects: projects.map(makeProject),
	});
}

function rojoProject(mountPath: string): string {
	return JSON.stringify({
		name: "pkg",
		tree: { $className: "DataModel", ReplicatedStorage: { Pkg: { $path: mountPath } } },
	});
}

function loadedPackage(overrides: Partial<ResolvedConfig>): LoadedPackage {
	return {
		descriptor: {
			name: "@halcyon/pkg",
			packageDirectory: PACKAGE_DIRECTORY,
			rojoProjectPath: ROJO_PROJECT_PATH,
		},
		info: { name: "@halcyon/pkg", packageDirectory: PACKAGE_DIRECTORY },
		pkgConfig: { ...DEFAULT_CONFIG, rootDir: PACKAGE_DIRECTORY, ...overrides },
	};
}

describe(applyProjectFilter, () => {
	const noFilterCases: Array<Array<string> | undefined> = [undefined, []];

	it.for(noFilterCases)("should return the original contexts for filter %j", (filter) => {
		expect.assertions(1);

		const contexts = [makeContext("@halcyon/a", ["unit"]), makeContext("@halcyon/b", ["e2e"])];

		expect(applyProjectFilter(contexts, filter)).toBe(contexts);
	});

	it("should keep only requested projects and drop empty package contexts", () => {
		expect.assertions(2);

		const unit = makeProject("unit");
		const integration = makeProject("integration");
		const e2e = makeProject("e2e");
		const first: PackageContext = fromAny({
			info: { name: "@halcyon/a" },
			projects: [unit, integration],
		});
		const second: PackageContext = fromAny({
			info: { name: "@halcyon/b" },
			projects: [e2e],
		});

		const filtered = applyProjectFilter([first, second], ["integration"]);

		expect(filtered).toStrictEqual([{ ...first, projects: [integration] }]);
		expect(filtered[0]!.projects[0]).toBe(integration);
	});

	it("should report every unknown name and every available project", () => {
		expect.assertions(1);

		const contexts = [
			makeContext("@halcyon/a", ["unit", "integration"]),
			makeContext("@halcyon/b", ["e2e"]),
		];

		expect(() => applyProjectFilter(contexts, ["missing", "other"])).toThrow(
			"Unknown project name(s): missing, other. Available: unit, integration, e2e",
		);
	});
});

describe(resolvePackageContextsAsync, () => {
	it("should synthesize one project from only the directory mounts in the Rojo tree", async () => {
		expect.assertions(3);

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
		const statSync = vi.spyOn(fileSystem, "statSync");

		const contexts = await resolvePackageContextsAsync({
			cacheDirectory: CACHE_DIRECTORY,
			fileSystem,
			loaded: [loadedPackage({ projects: [] })],
		});
		const context = contexts[0];
		assert(context !== undefined);
		const { projects } = context;
		const firstProject = projects[0];
		assert(firstProject !== undefined);
		const packageDirectory = normalizeWindowsPath(PACKAGE_DIRECTORY);
		const probedPaths = statSync.mock.calls.map(([file]) => file);

		expect(projects).toHaveLength(1);
		expect(firstProject.include).toStrictEqual(
			DEFAULT_CONFIG.testMatch.map((pattern) => path.posix.join("src/shared", pattern)),
		);
		expect(probedPaths).toStrictEqual([
			path.posix.join(packageDirectory, "src/shared"),
			path.posix.join(packageDirectory, "src/source.luau"),
		]);
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
			fileSystem,
			loaded: [loadedPackage({ projects: ["src/shared"] })],
		});

		const project = contexts[0]!.projects[0]!;

		expect(project.displayName).toBe("shared-luau");
		expect(project.include).toStrictEqual(["src/shared/**/*.spec.luau"]);
	});

	it("should build the setup resolver through the injected factory", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(PACKAGE_DIRECTORY, "src/pkg.spec.luau")]: "",
			[path.join(PACKAGE_DIRECTORY, "src/setup.luau")]: "",
			[ROJO_PROJECT_PATH]: rojoProject("src"),
		});

		const createResolver = vi.fn<RojoResolverFactory>().mockReturnValue(
			fromAny({
				getRbxPathFromFilePath() {
					return ["ReplicatedStorage", "Pkg", "setup"];
				},
			}),
		);

		const contexts = await resolvePackageContextsAsync({
			cacheDirectory: CACHE_DIRECTORY,
			createResolver,
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
		});

		expect(createResolver).toHaveBeenCalledWith(ROJO_PROJECT_PATH);
		expect(contexts[0]!.projects[0]!.config.setupFiles).toStrictEqual([
			"ReplicatedStorage/Pkg/setup",
		]);
	});
});
