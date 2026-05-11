import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { ResolvedConfig } from "../config/schema.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { CoverageManifest, InstrumentedFileRecord } from "./types.ts";
import { prepareWorkspaceCoverage } from "./workspace-prepare.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});
vi.mock(import("./instrumenter"));

const WORKSPACE_ROOT = path.resolve("/repo");
const FOO_DIR = path.join(WORKSPACE_ROOT, "packages/foo");
const BAR_DIR = path.join(WORKSPACE_ROOT, "packages/bar");
const FOO_PROJECT = path.join(FOO_DIR, "test.project.json");
const BAR_PROJECT = path.join(BAR_DIR, "test.project.json");

interface SeedOptions {
	luauRoots?: Array<string>;
	rojoTree?: object;
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...DEFAULT_CONFIG, rootDir: WORKSPACE_ROOT, ...overrides };
}

function seedPackage(packageDirectory: string, options: SeedOptions = {}): void {
	const {
		luauRoots = ["out"],
		rojoTree = {
			$className: "DataModel",
			ReplicatedStorage: { Pkg: { $path: "out" } },
		},
	} = options;

	vol.fromJSON({
		[path.join(packageDirectory, "test.project.json")]: JSON.stringify({
			name: "pkg-test",
			tree: rojoTree,
		}),
	});
	for (const luauRoot of luauRoots) {
		vol.mkdirSync(path.join(packageDirectory, luauRoot), { recursive: true });
		vol.writeFileSync(path.join(packageDirectory, luauRoot, "init.luau"), "local x = 1");
	}
}

async function mockInstrumentRoot(
	implementation?: (options: {
		luauRoot: string;
		shadowDir: string;
	}) => Record<string, InstrumentedFileRecord>,
): Promise<ReturnType<typeof vi.fn>> {
	const { instrumentRoot } = await import("./instrumenter.ts");
	const mocked = vi.mocked(instrumentRoot);
	mocked.mockImplementation(
		implementation ??
			(({ luauRoot }) => {
				const key = `${luauRoot}/init.luau`;
				return {
					[key]: {
						key,
						coverageMapPath: `${luauRoot}/init.cov-map.json`,
						instrumentedLuauPath: `${luauRoot}/init.luau`,
						originalLuauPath: `${luauRoot}/init.luau`,
						sourceHash: "deadbeef",
						sourceMapPath: `${luauRoot}/init.luau.map`,
						statementCount: 1,
					},
				};
			}),
	);
	return mocked;
}

describe(prepareWorkspaceCoverage, () => {
	it("should return per-package coverage roots whose luauRoot is package-relative and shadowDir is absolute", async () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		seedPackage(FOO_DIR);
		await mockInstrumentRoot();

		const result = prepareWorkspaceCoverage({
			config: makeConfig(),
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(result).toHaveLength(1);
		expect(result[0]?.coverageRoots).toStrictEqual([
			{
				luauRoot: "out",
				shadowDir: path
					.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out")
					.replaceAll("\\", "/"),
			},
		]);
	});

	it("should write a per-package manifest at workspace-root-scoped path", async () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		seedPackage(FOO_DIR);
		await mockInstrumentRoot();

		const result = prepareWorkspaceCoverage({
			config: makeConfig(),
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		const expectedPath = path.join(
			WORKSPACE_ROOT,
			".jest-roblox/workspace/@halcyon-foo/coverage/manifest.json",
		);

		expect(result[0]?.manifestPath).toBe(expectedPath.replaceAll("\\", "/"));
		expect(vol.existsSync(expectedPath)).toBeTrue();
	});

	it("should call instrumentRoot once per discovered luau root in each package", async () => {
		expect.assertions(3);

		onTestFinished(() => {
			vol.reset();
		});

		seedPackage(FOO_DIR, {
			luauRoots: ["out/client", "out/server"],
			rojoTree: {
				$className: "DataModel",
				ReplicatedStorage: { Client: { $path: "out/client" } },
				ServerScriptService: { Server: { $path: "out/server" } },
			},
		});
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			config: makeConfig(),
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).toHaveBeenCalledTimes(2);

		const luauRoots = mocked.mock.calls.map(
			(call) => (call[0] as { luauRoot: string }).luauRoot,
		);

		expect(luauRoots).toContain(path.join(FOO_DIR, "out/client").replaceAll("\\", "/"));
		expect(luauRoots).toContain(path.join(FOO_DIR, "out/server").replaceAll("\\", "/"));
	});

	it("should isolate shadow dirs and manifests between packages", async () => {
		expect.assertions(4);

		onTestFinished(() => {
			vol.reset();
		});

		seedPackage(FOO_DIR);
		seedPackage(BAR_DIR);
		await mockInstrumentRoot();

		const result = prepareWorkspaceCoverage({
			config: makeConfig(),
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
				{ name: "@halcyon/bar", packageDirectory: BAR_DIR, rojoProjectPath: BAR_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		const fooManifest = path.join(
			WORKSPACE_ROOT,
			".jest-roblox/workspace/@halcyon-foo/coverage/manifest.json",
		);
		const barManifest = path.join(
			WORKSPACE_ROOT,
			".jest-roblox/workspace/@halcyon-bar/coverage/manifest.json",
		);

		expect(result.find((entry) => entry.pkg === "@halcyon/foo")?.manifestPath).toBe(
			fooManifest.replaceAll("\\", "/"),
		);
		expect(result.find((entry) => entry.pkg === "@halcyon/bar")?.manifestPath).toBe(
			barManifest.replaceAll("\\", "/"),
		);
		expect(vol.existsSync(fooManifest)).toBeTrue();
		expect(vol.existsSync(barManifest)).toBeTrue();
	});

	it("should aggregate instrumented file records into the per-package manifest", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		seedPackage(FOO_DIR);
		await mockInstrumentRoot();

		const [result] = prepareWorkspaceCoverage({
			config: makeConfig(),
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		const manifest = JSON.parse(
			vol.readFileSync(result!.manifestPath, "utf-8") as string,
		) as unknown as CoverageManifest;
		const expectedKey = `${path.join(FOO_DIR, "out").replaceAll("\\", "/")}/init.luau`;

		expect(Object.keys(manifest.files)).toContain(expectedKey);
	});

	it("should skip $path entries that escape the package directory", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		// $path: "../bar" resolves to the SIBLING package, outside FOO_DIR.
		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Escape: { $path: "../bar" } },
				},
			}),
			[path.join(BAR_DIR, "init.luau")]: "local x = 1",
		});
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			config: makeConfig(),
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
	});

	it("should skip $path entries that do not exist on disk", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Missing: { $path: "does-not-exist" } },
				},
			}),
		});
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			config: makeConfig(),
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
	});

	it("should skip $path entries matching coveragePathIgnorePatterns", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		seedPackage(FOO_DIR, {
			luauRoots: ["node_modules"],
			rojoTree: {
				$className: "DataModel",
				ReplicatedStorage: { Vendor: { $path: "node_modules" } },
			},
		});
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			config: makeConfig({ coveragePathIgnorePatterns: ["node_modules"] }),
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
	});

	it("should skip $path entries that resolve to files (not directories)", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Single: { $path: "init.luau" } },
				},
			}),
			[path.join(FOO_DIR, "init.luau")]: "local x = 1",
		});
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			config: makeConfig(),
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
	});

	it("should skip directories that contain no .luau files", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Empty: { $path: "vendor" } },
				},
			}),
			[path.join(FOO_DIR, "vendor/readme.txt")]: "",
			[path.join(FOO_DIR, "vendor/sub/data.json")]: "{}",
		});
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			config: makeConfig(),
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
	});

	it("should dedupe duplicate $path entries within a single package", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { A: { $path: "src" }, B: { $path: "src" } },
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "local x = 1",
		});
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			config: makeConfig(),
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).toHaveBeenCalledOnce();
	});

	it("should treat an empty coveragePathIgnorePatterns list as ignoring nothing", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		seedPackage(FOO_DIR);
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			config: makeConfig({ coveragePathIgnorePatterns: [] }),
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).toHaveBeenCalledOnce();
	});

	it("should skip packages whose rojo tree has no instrumentable luau roots", async () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		// Package whose tree has no $path entries → nothing to instrument
		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: { $className: "DataModel" },
			}),
		});
		const mocked = await mockInstrumentRoot();

		const result = prepareWorkspaceCoverage({
			config: makeConfig(),
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
		expect(result[0]?.coverageRoots).toStrictEqual([]);
	});
});
