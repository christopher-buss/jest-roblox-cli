import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { clockTimingCollector } from "#test/mocks/clock-timing-collector.ts";
import { createLuteChildProcess } from "#test/mocks/lute-child-process.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { SetupResolverFactory } from "../config/setup-resolver.ts";
import type { TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { openWorkspaceRunAsync } from "./open-run.ts";
import type { PackageInfo } from "./package-resolver.ts";

const ROOT = path.resolve("/repo");
const FOO_DIR = path.join(ROOT, "packages/foo");
const BAR_DIR = path.join(ROOT, "packages/bar");
const FOO_INFO = { name: "@halcyon/foo", packageDirectory: FOO_DIR };
const BAR_INFO = { name: "@halcyon/bar", packageDirectory: BAR_DIR };
const WORKSPACE_FILE = { [path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n" };

type PackageConfigs = Readonly<Record<string, ResolvedConfig>>;

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

const DEFAULT_CONFIGS: PackageConfigs = {
	[BAR_DIR]: createResolvedConfig({ rootDir: BAR_DIR }),
	[FOO_DIR]: createResolvedConfig({ rootDir: FOO_DIR }),
};

type OpenOverrides = Partial<Parameters<typeof openWorkspaceRunAsync>[0]> & {
	configs?: PackageConfigs;
	packageInfos?: Array<PackageInfo>;
};

function openOptions(
	fileSystem: FileSystem,
	{ configs = DEFAULT_CONFIGS, packageInfos = [FOO_INFO], ...overrides }: OpenOverrides = {},
): Parameters<typeof openWorkspaceRunAsync>[0] {
	return {
		childProcess: createLuteChildProcess({ version: "1.0.1" }),
		cli: {},
		createSetupResolver: vi.fn<SetupResolverFactory>(() => {
			throw new Error("unexpected createSetupResolver call");
		}),
		cwd: ROOT,
		fileSystem,
		packages: packageInfos.map((info) => {
			return { config: { declared: {}, resolved: configs[info.packageDirectory]! }, info };
		}),
		timing: clockTimingCollector(),
		tsconfigReader: vi.fn<TsconfigReader>(() => null),
		workspaceRoot: ROOT,
		...overrides,
	};
}

function fooConfig(overrides: Partial<ResolvedConfig> = {}): PackageConfigs {
	return { [FOO_DIR]: { ...createResolvedConfig(), rootDir: FOO_DIR, ...overrides } };
}

async function openEmptyFooAsync(overrides: Partial<ResolvedConfig> = {}) {
	const { fileSystem, volume } = createMemoryFileSystem();
	const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	volume.fromJSON({ ...seedPackage(FOO_DIR, "@halcyon/foo"), ...WORKSPACE_FILE });

	const opened = await openWorkspaceRunAsync(
		openOptions(fileSystem, { configs: fooConfig(overrides) }),
	);
	return { opened, stderr };
}

describe(openWorkspaceRunAsync, () => {
	it("should error with no tests when passWithNoTests is false", async () => {
		expect.assertions(1);

		const pending = openEmptyFooAsync();

		await expect(pending).rejects.toThrow("Could not determine luauRoots");
	});

	it("should still error for a truly empty package even with typecheck enabled", async () => {
		expect.assertions(1);

		const pending = openEmptyFooAsync({
			testMatch: ["**/*.spec.ts"],
			typecheck: { enabled: true },
		});

		await expect(pending).rejects.toThrow("Could not determine luauRoots");
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
				configs: fooConfig(),
				cwd: ROOT,
			}),
		);

		expect(opened!.cacheDirectory).toBe(path.join(ROOT, ".jest-roblox", "workspace"));
		expect(opened!.selection.pending.map((entry) => entry.job.pkg)).toStrictEqual([
			"@halcyon/foo",
		]);
	});
});
