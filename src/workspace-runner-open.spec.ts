import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { clockTimingCollector } from "#test/mocks/clock-timing-collector.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { PackageConfigLoader } from "./config/loader.ts";
import type { ResolvedConfig } from "./config/schema.ts";
import type { TsconfigReader } from "./executor/tsconfig-mappings.ts";
import type { FileSystem } from "./utils/file-system.ts";
import type { RojoResolverFactory } from "./utils/rojo-project-reader.ts";
import { openWorkspaceRunAsync } from "./workspace-runner-open.ts";

const ROOT = path.resolve("/repo");
const FOO_DIR = path.join(ROOT, "packages/foo");
const BAR_DIR = path.join(ROOT, "packages/bar");
const FOO_INFO = { name: "@halcyon/foo", packageDirectory: FOO_DIR };
const BAR_INFO = { name: "@halcyon/bar", packageDirectory: BAR_DIR };
const WORKSPACE_FILE = { [path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n" };

function packageJson(json: JSONObject): string {
	return JSON.stringify(json);
}

function seedPackage(directory: string, name: string): Record<string, string> {
	return {
		[path.join(directory, "jest.config.ts")]: "export default {}",
		[path.join(directory, "package.json")]: packageJson({ name }),
		[path.join(directory, "test.project.json")]: packageJson({
			name: `${name}-test`,
			tree: { $className: "DataModel", ReplicatedStorage: { Pkg: { $path: "src" } } },
		}),
	};
}

function configLoader(configs: Readonly<Record<string, Partial<ResolvedConfig>>>) {
	return vi.fn<PackageConfigLoader>(async ({ cwd } = {}) => {
		const config = configs[cwd ?? ""];
		if (config === undefined) {
			throw new Error(`No mocked config for cwd: ${cwd ?? "<undefined>"}`);
		}

		return fromAny<ResolvedConfig, Partial<ResolvedConfig>>(config);
	});
}

function openOptions(
	fileSystem: FileSystem,
	overrides: Partial<Parameters<typeof openWorkspaceRunAsync>[0]> = {},
): Parameters<typeof openWorkspaceRunAsync>[0] {
	return {
		cli: {},
		createResolver: vi.fn<RojoResolverFactory>(() => {
			throw new Error("unexpected createResolver call");
		}),
		fileSystem,
		loadPackageConfig: configLoader({
			[BAR_DIR]: createResolvedConfig({ rootDir: BAR_DIR }),
			[FOO_DIR]: createResolvedConfig({ rootDir: FOO_DIR }),
		}),
		packageInfos: [FOO_INFO],
		timing: clockTimingCollector(),
		tsconfigReader: vi.fn<TsconfigReader>(() => null),
		workspaceRoot: ROOT,
		...overrides,
	};
}

function fooConfig(overrides: Partial<ResolvedConfig> = {}) {
	return configLoader({
		[FOO_DIR]: { ...createResolvedConfig(), rootDir: FOO_DIR, ...overrides },
	});
}

async function openEmptyFooAsync(overrides: Partial<ResolvedConfig> = {}) {
	const { fileSystem, volume } = createMemoryFileSystem();
	const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	volume.fromJSON({ ...seedPackage(FOO_DIR, "@halcyon/foo"), ...WORKSPACE_FILE });

	const opened = await openWorkspaceRunAsync(
		openOptions(fileSystem, { loadPackageConfig: fooConfig(overrides) }),
	);
	return { opened, stderr };
}

describe(openWorkspaceRunAsync, () => {
	it("should error with no tests when passWithNoTests is false", async () => {
		expect.assertions(2);

		const { opened, stderr } = await openEmptyFooAsync();

		expect(opened).toBeUndefined();
		expect(stderr).toHaveBeenCalledWith(
			expect.stringMatching(/No test files found in package @halcyon\/foo/),
		);
	});

	it("should still error for a truly empty package even with typecheck enabled", async () => {
		expect.assertions(2);

		const { opened, stderr } = await openEmptyFooAsync({
			testMatch: ["**/*.spec.ts"],
			typecheck: { enabled: true },
		});

		expect(opened).toBeUndefined();
		expect(stderr).toHaveBeenCalledWith(
			expect.stringMatching(/No test files found in package @halcyon\/foo/),
		);
	});

	it("should surface preflight errors", async () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		volume.fromJSON({
			[path.join(BAR_DIR, "package.json")]: packageJson({ name: "@halcyon/bar" }),
			[path.join(FOO_DIR, "package.json")]: packageJson({ name: "@halcyon/foo" }),
			[path.join(FOO_DIR, "test.project.json")]: packageJson({
				name: "foo-test",
				tree: { $className: "DataModel" },
			}),
			...WORKSPACE_FILE,
		});

		const opened = await openWorkspaceRunAsync(
			openOptions(fileSystem, { packageInfos: [FOO_INFO, BAR_INFO] }),
		);

		expect(opened).toBeUndefined();
		expect(stderr).toHaveBeenCalledWith("Pre-flight validation failed:\n");
		expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/@halcyon\/bar/));
	});

	it("should defer malformed rojo project to preflight without crashing ensure-paths", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		volume.fromJSON({
			[path.join(FOO_DIR, "package.json")]: packageJson({ name: "@halcyon/foo" }),
			[path.join(FOO_DIR, "test.project.json")]: "not valid json {{",
			...WORKSPACE_FILE,
		});

		const opened = await openWorkspaceRunAsync(openOptions(fileSystem));

		expect(opened).toBeUndefined();
		expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/failed to parse rojoProject/));
	});

	it("should select the tests of a package that passes preflight", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
			...seedPackage(FOO_DIR, "@halcyon/foo"),
			[path.join(FOO_DIR, "src/foo.spec.luau")]: "",
			...WORKSPACE_FILE,
		});

		const opened = await openWorkspaceRunAsync(
			openOptions(fileSystem, {
				cwd: ROOT,
				loadPackageConfig: fooConfig(),
			}),
		);

		expect(opened!.cacheDirectory).toBe(path.join(ROOT, ".jest-roblox", "workspace"));
		expect(opened!.selection.pending.map((entry) => entry.pkg)).toStrictEqual(["@halcyon/foo"]);
	});
});
