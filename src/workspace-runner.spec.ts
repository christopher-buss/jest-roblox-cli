import { RojoResolver } from "@roblox-ts/rojo-resolver";
import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import type { Backend, BackendOptions, BackendResult } from "./backends/interface.ts";
import { loadConfig } from "./config/loader.ts";
import type { CliOptions, ResolvedConfig } from "./config/schema.ts";
import { DEFAULT_CONFIG } from "./config/schema.ts";
import { runWorkspace } from "./workspace-runner.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

vi.mock(import("./utils/rojo-builder.ts"));

vi.mock(import("./config/loader.ts"), async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, loadConfig: vi.fn<typeof actual.loadConfig>(actual.loadConfig) };
});

vi.mock(import("@roblox-ts/rojo-resolver"));

const ROOT = path.resolve("/repo");
const FOO_DIR = path.join(ROOT, "packages/foo");
const BAR_DIR = path.join(ROOT, "packages/bar");
const BAZ_DIR = path.join(ROOT, "packages/baz");
const FOO_INFO = { name: "@halcyon/foo", packageDirectory: FOO_DIR };
const BAR_INFO = { name: "@halcyon/bar", packageDirectory: BAR_DIR };
const BAZ_INFO = { name: "@halcyon/baz", packageDirectory: BAZ_DIR };

interface BackendStubEntry {
	jestOutput: string;
	pkg?: string;
	project?: string;
}

function packageJson(json: object): string {
	return String(JSON.stringify(json));
}

function passingResult(): string {
	return JSON.stringify({
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: 0,
		success: true,
		testResults: [],
	});
}

function failingResult(): string {
	return JSON.stringify({
		numFailedTests: 1,
		numPassedTests: 0,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: 0,
		success: false,
		testResults: [],
	});
}

function createStubBackend(entries: Array<BackendStubEntry>): {
	backend: Backend;
	captured: { options?: BackendOptions };
} {
	const captured: { options?: BackendOptions } = {};
	const backend: Backend = {
		kind: "open-cloud",
		runTests: async (options: BackendOptions): Promise<BackendResult> => {
			captured.options = options;
			return {
				results: entries.map((entry) => {
					return {
						displayName: entry.project ?? entry.pkg ?? "",
						elapsedMs: 0,
						result: JSON.parse(entry.jestOutput) as never,
					};
				}),
				timing: { executionMs: 0, uploadMs: 0 },
			};
		},
	};
	return { backend, captured };
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...DEFAULT_CONFIG, rootDir: FOO_DIR, ...overrides };
}

function makeCli(overrides: Partial<CliOptions> = {}): CliOptions {
	return { ...overrides };
}

function emptyJestConfig(directory: string): Record<string, string> {
	return {
		[path.join(directory, "jest.config.ts")]: "export default {}",
	};
}

function setLoadedConfigPerPackage(map: Record<string, unknown>): void {
	vi.mocked(loadConfig).mockImplementation(async (_path, cwd) => {
		const config = map[cwd ?? ""];
		if (config === undefined) {
			throw new Error(`No mocked config for cwd: ${cwd ?? "<undefined>"}`);
		}

		return fromAny(config);
	});
}

function seedPackage(
	directory: string,
	options: {
		extras?: Record<string, string>;
		name: string;
		specFiles?: Record<string, string>;
		tree?: object;
	},
): Record<string, string> {
	const tree = options.tree ?? {
		$className: "DataModel",
		ReplicatedStorage: { Pkg: { $path: "src" } },
	};
	return {
		[path.join(directory, "package.json")]: packageJson({ name: options.name }),
		[path.join(directory, "test.project.json")]: packageJson({
			name: `${options.name}-test`,
			tree,
		}),
		...emptyJestConfig(directory),
		...options.specFiles,
		...options.extras,
	};
}

describe(runWorkspace, () => {
	it("should load each package's config independently and embed both in the materializer payload", async () => {
		expect.assertions(2);

		vol.reset();
		vol.fromJSON({
			...seedPackage(FOO_DIR, {
				name: "@halcyon/foo",
				specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
			}),
			...seedPackage(BAR_DIR, {
				name: "@halcyon/bar",
				specFiles: { [path.join(BAR_DIR, "src/bar.spec.luau")]: "" },
			}),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		setLoadedConfigPerPackage({
			[BAR_DIR]: { ...DEFAULT_CONFIG, rootDir: BAR_DIR, testTimeout: 5678 },
			[FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR, testTimeout: 1234 },
		});

		const { backend, captured } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			{ jestOutput: passingResult(), pkg: "@halcyon/bar" },
		]);

		await runWorkspace({
			backend,
			cli: makeCli(),
			config: makeConfig(),
			packageInfos: [FOO_INFO, BAR_INFO],
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(captured.options?.scriptOverride).toContain('"testTimeout":1234');
		expect(captured.options?.scriptOverride).toContain('"testTimeout":5678');
	});

	it("should synthesize one virtual project named after the package when projects: is absent", async () => {
		expect.assertions(2);

		vol.reset();
		vol.fromJSON({
			...seedPackage(FOO_DIR, {
				name: "@halcyon/foo",
				specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
			}),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		setLoadedConfigPerPackage({
			[FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR },
		});

		const { backend, captured } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "@halcyon/foo" },
		]);

		const results = await runWorkspace({
			backend,
			cli: makeCli(),
			config: makeConfig(),
			packageInfos: [FOO_INFO],
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(captured.options?.scriptOverride).toContain('"project":"@halcyon/foo"');
		expect(results?.[0]?.displayName).toBe("@halcyon/foo");
	});

	it("should pass through explicit projects when present, not virtual-wrap", async () => {
		expect.assertions(3);

		vol.reset();
		vol.fromJSON({
			...seedPackage(FOO_DIR, {
				name: "@halcyon/foo",
				specFiles: {
					[path.join(FOO_DIR, "out/Client/foo.spec.luau")]: "",
					[path.join(FOO_DIR, "out/Server/bar.spec.luau")]: "",
				},
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Client: { $path: "out/Client" } },
					ServerScriptService: { Server: { $path: "out/Server" } },
				},
			}),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		const projects = fromAny([
			{ test: { displayName: "client", include: ["out/Client/**/*.spec.luau"] } },
			{ test: { displayName: "server", include: ["out/Server/**/*.spec.luau"] } },
		]);
		setLoadedConfigPerPackage({
			[FOO_DIR]: { ...DEFAULT_CONFIG, projects, rootDir: FOO_DIR },
		});

		const { backend, captured } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "client" },
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "server" },
		]);

		const results = await runWorkspace({
			backend,
			cli: makeCli(),
			config: makeConfig(),
			packageInfos: [FOO_INFO],
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(captured.options?.scriptOverride).toContain('"project":"client"');
		expect(captured.options?.scriptOverride).toContain('"project":"server"');
		expect(results?.map((entry) => entry.displayName)).toStrictEqual(["client", "server"]);
	});

	it("should write stubs into the workspace cache, not into package source", async () => {
		expect.assertions(2);

		vol.reset();
		vol.fromJSON({
			...seedPackage(FOO_DIR, {
				name: "@halcyon/foo",
				specFiles: { [path.join(FOO_DIR, "out/Client/spec.spec.luau")]: "" },
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Client: { $path: "out/Client" } },
				},
			}),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		const projects = fromAny([
			{ test: { displayName: "client", include: ["out/Client/**/*.spec.luau"] } },
		]);
		setLoadedConfigPerPackage({
			[FOO_DIR]: { ...DEFAULT_CONFIG, projects, rootDir: FOO_DIR },
		});

		const { backend } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "client" },
		]);

		await runWorkspace({
			backend,
			cli: makeCli(),
			config: makeConfig(),
			packageInfos: [FOO_INFO],
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		const cacheStub = path.join(
			ROOT,
			".jest-roblox/workspace/@halcyon/foo/out/Client/jest.config.luau",
		);
		const sourceStub = path.join(FOO_DIR, "out/Client/jest.config.luau");

		expect(vol.existsSync(cacheStub)).toBeTrue();
		expect(vol.existsSync(sourceStub)).toBeFalse();
	});

	it("should fan out (P × N) jobs, one per (package, project) pair", async () => {
		expect.assertions(2);

		vol.reset();
		vol.fromJSON({
			...seedPackage(FOO_DIR, {
				name: "@halcyon/foo",
				specFiles: {
					[path.join(FOO_DIR, "out/Client/foo.spec.luau")]: "",
					[path.join(FOO_DIR, "out/Server/foo.spec.luau")]: "",
				},
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Client: { $path: "out/Client" } },
					ServerScriptService: { Server: { $path: "out/Server" } },
				},
			}),
			...seedPackage(BAR_DIR, {
				name: "@halcyon/bar",
				specFiles: {
					[path.join(BAR_DIR, "out/Client/bar.spec.luau")]: "",
					[path.join(BAR_DIR, "out/Server/bar.spec.luau")]: "",
				},
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Client: { $path: "out/Client" } },
					ServerScriptService: { Server: { $path: "out/Server" } },
				},
			}),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		const projects = fromAny([
			{ test: { displayName: "client", include: ["out/Client/**/*.spec.luau"] } },
			{ test: { displayName: "server", include: ["out/Server/**/*.spec.luau"] } },
		]);
		setLoadedConfigPerPackage({
			[BAR_DIR]: { ...DEFAULT_CONFIG, projects, rootDir: BAR_DIR },
			[FOO_DIR]: { ...DEFAULT_CONFIG, projects, rootDir: FOO_DIR },
		});

		const { backend, captured } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "client" },
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "server" },
			{ jestOutput: passingResult(), pkg: "@halcyon/bar", project: "client" },
			{ jestOutput: passingResult(), pkg: "@halcyon/bar", project: "server" },
		]);

		const results = await runWorkspace({
			backend,
			cli: makeCli(),
			config: makeConfig(),
			packageInfos: [FOO_INFO, BAR_INFO],
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(captured.options?.jobs).toHaveLength(4);
		expect(results).toHaveLength(4);
	});

	it("should keep only filtered project displayNames when --project is set", async () => {
		expect.assertions(2);

		vol.reset();
		vol.fromJSON({
			...seedPackage(FOO_DIR, {
				name: "@halcyon/foo",
				specFiles: {
					[path.join(FOO_DIR, "out/Client/spec.spec.luau")]: "",
					[path.join(FOO_DIR, "out/Server/spec.spec.luau")]: "",
				},
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Client: { $path: "out/Client" } },
					ServerScriptService: { Server: { $path: "out/Server" } },
				},
			}),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		const projects = fromAny([
			{ test: { displayName: "client", include: ["out/Client/**/*.spec.luau"] } },
			{ test: { displayName: "server", include: ["out/Server/**/*.spec.luau"] } },
		]);
		setLoadedConfigPerPackage({
			[FOO_DIR]: { ...DEFAULT_CONFIG, projects, rootDir: FOO_DIR },
		});

		const { backend } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "client" },
		]);

		const results = await runWorkspace({
			backend,
			cli: makeCli({ project: ["client"] }),
			config: makeConfig(),
			packageInfos: [FOO_INFO],
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(results).toHaveLength(1);
		expect(results?.[0]?.displayName).toBe("client");
	});

	it("should throw when --project filter names match no project across packages", async () => {
		expect.assertions(1);

		vol.reset();
		vol.fromJSON({
			...seedPackage(FOO_DIR, {
				name: "@halcyon/foo",
				specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
			}),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		setLoadedConfigPerPackage({
			[FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR },
		});

		const { backend } = createStubBackend([]);

		await expect(
			runWorkspace({
				backend,
				cli: makeCli({ project: ["nonexistent"] }),
				config: makeConfig(),
				packageInfos: [FOO_INFO],
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			}),
		).rejects.toThrow(/Unknown project name/);
	});

	it("should resolve per-project setupFiles and setupFilesAfterEnv against the package's rojo tree", async () => {
		expect.assertions(2);

		vol.reset();
		vol.fromJSON({
			...seedPackage(FOO_DIR, {
				name: "@halcyon/foo",
				specFiles: {
					[path.join(FOO_DIR, "src/foo.spec.luau")]: "",
					[path.join(FOO_DIR, "src/Shared/setup.luau")]: "",
				},
			}),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		setLoadedConfigPerPackage({
			[FOO_DIR]: {
				...DEFAULT_CONFIG,
				rootDir: FOO_DIR,
				setupFiles: ["./src/Shared/setup.luau"],
				setupFilesAfterEnv: ["./src/Shared/setup.luau"],
			},
		});

		// Mock the RojoResolver so the resolver's filesystem walk doesn't
		// hit the real fs (memfs only mocks node:fs, not fs-extra).
		const mapping: Record<string, Array<string>> = {
			[path.resolve(FOO_DIR, "./src/Shared/setup.luau")]: [
				"ReplicatedStorage",
				"Pkg",
				"Shared",
				"setup",
			],
		};
		vi.mocked(RojoResolver.fromPath).mockReturnValue({
			getRbxPathFromFilePath(filePath: string) {
				return mapping[filePath];
			},
		} as unknown as RojoResolver);

		const { backend, captured } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "@halcyon/foo" },
		]);

		await runWorkspace({
			backend,
			cli: makeCli(),
			config: makeConfig(),
			packageInfos: [FOO_INFO],
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		// The resolver replaces the filesystem string with the DataModel
		// path so the materializer payload carries the resolved setup
		// location, not the raw source path. Both setupFiles and
		// setupFilesAfterEnv are resolved.
		expect(captured.options?.scriptOverride).toContain(
			'"setupFiles":["ReplicatedStorage/Pkg/Shared/setup"]',
		);
		expect(captured.options?.scriptOverride).toContain(
			'"setupFilesAfterEnv":["ReplicatedStorage/Pkg/Shared/setup"]',
		);
	});

	it("should honor per-package rojoProject from each package's own jest.config", async () => {
		expect.assertions(2);

		vol.reset();
		vol.fromJSON({
			[path.join(BAR_DIR, "custom.project.json")]: packageJson({
				name: "bar-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Pkg: { $path: "src" } },
				},
			}),
			[path.join(BAR_DIR, "jest.config.ts")]: "export default {}",
			// Bar has ONLY custom.project.json — no test.project.json on disk.
			// Bar's per-package config sets rojoProject: "custom.project.json".
			// If the per-package value is ignored, preflight fails because the
			// default test.project.json does not exist at Bar.
			[path.join(BAR_DIR, "package.json")]: packageJson({ name: "@halcyon/bar" }),
			[path.join(BAR_DIR, "src/bar.spec.luau")]: "",
			[path.join(FOO_DIR, "jest.config.ts")]: "export default {}",
			[path.join(FOO_DIR, "package.json")]: packageJson({ name: "@halcyon/foo" }),
			[path.join(FOO_DIR, "src/foo.spec.luau")]: "",
			// Foo has only test.project.json (default).
			[path.join(FOO_DIR, "test.project.json")]: packageJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Pkg: { $path: "src" } },
				},
			}),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		setLoadedConfigPerPackage({
			[BAR_DIR]: {
				...DEFAULT_CONFIG,
				rojoProject: "custom.project.json",
				rootDir: BAR_DIR,
			},
			[FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR },
		});

		const { backend, captured } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "@halcyon/foo" },
			{ jestOutput: passingResult(), pkg: "@halcyon/bar", project: "@halcyon/bar" },
		]);

		const results = await runWorkspace({
			backend,
			cli: makeCli(),
			config: makeConfig(),
			packageInfos: [FOO_INFO, BAR_INFO],
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		// Both packages produce jobs because each package's own rojoProject
		// resolves correctly. Without the fix, Bar's preflight fails on the
		// non-existent test.project.json (the parent default).
		expect(captured.options?.jobs).toHaveLength(2);
		expect(results?.map((entry) => entry.pkg)).toStrictEqual(["@halcyon/foo", "@halcyon/bar"]);
	});

	it("should drop empty packages from the materializer payload while keeping packages with specs", async () => {
		expect.assertions(2);

		vol.reset();
		vol.fromJSON({
			...seedPackage(FOO_DIR, {
				name: "@halcyon/foo",
				specFiles: {
					[path.join(FOO_DIR, "src/a.spec.luau")]: "",
					[path.join(FOO_DIR, "src/b.spec.luau")]: "",
				},
			}),
			...seedPackage(BAR_DIR, { name: "@halcyon/bar" }),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		setLoadedConfigPerPackage({
			[BAR_DIR]: { ...DEFAULT_CONFIG, rootDir: BAR_DIR },
			[FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR },
		});

		const { backend, captured } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "@halcyon/foo" },
		]);

		const results = await runWorkspace({
			backend,
			cli: makeCli(),
			config: makeConfig(),
			packageInfos: [FOO_INFO, BAR_INFO],
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		// The empty bar package must NOT produce a job; only foo's job is
		// enqueued because foo is the only package with discovered specs.
		expect(captured.options?.jobs).toHaveLength(1);
		expect(results?.map((entry) => entry.pkg)).toStrictEqual(["@halcyon/foo"]);
	});

	it("should pass with no tests when passWithNoTests is true and zero specs are discovered", async () => {
		expect.assertions(1);

		vol.reset();
		vol.fromJSON({
			...seedPackage(FOO_DIR, { name: "@halcyon/foo" }),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		setLoadedConfigPerPackage({
			[FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR },
		});

		const { backend } = createStubBackend([]);

		const results = await runWorkspace({
			backend,
			cli: makeCli(),
			config: makeConfig({ passWithNoTests: true }),
			packageInfos: [FOO_INFO],
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(results).toStrictEqual([]);
	});

	it("should error 2 with no tests when passWithNoTests is false", async () => {
		expect.assertions(2);

		vol.reset();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		vol.fromJSON({
			...seedPackage(FOO_DIR, { name: "@halcyon/foo" }),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		setLoadedConfigPerPackage({
			[FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR },
		});

		const { backend } = createStubBackend([]);

		const results = await runWorkspace({
			backend,
			cli: makeCli(),
			config: makeConfig(),
			packageInfos: [FOO_INFO],
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(results).toBeUndefined();
		expect(stderr).toHaveBeenCalledWith(
			expect.stringMatching(/No test files found in any package/),
		);
	});

	it("should map each backend result to a WorkspaceProjectResult preserving pkg + project axes", async () => {
		expect.assertions(4);

		vol.reset();
		vol.fromJSON({
			...seedPackage(FOO_DIR, {
				name: "@halcyon/foo",
				specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
			}),
			...seedPackage(BAR_DIR, {
				name: "@halcyon/bar",
				specFiles: { [path.join(BAR_DIR, "src/bar.spec.luau")]: "" },
			}),
			...seedPackage(BAZ_DIR, {
				name: "@halcyon/baz",
				specFiles: { [path.join(BAZ_DIR, "src/baz.spec.luau")]: "" },
			}),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		setLoadedConfigPerPackage({
			[BAR_DIR]: { ...DEFAULT_CONFIG, rootDir: BAR_DIR },
			[BAZ_DIR]: { ...DEFAULT_CONFIG, rootDir: BAZ_DIR },
			[FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR },
		});

		const { backend } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "@halcyon/foo" },
			{ jestOutput: failingResult(), pkg: "@halcyon/bar", project: "@halcyon/bar" },
			{ jestOutput: passingResult(), pkg: "@halcyon/baz", project: "@halcyon/baz" },
		]);

		const results = await runWorkspace({
			backend,
			cli: makeCli(),
			config: makeConfig(),
			packageInfos: [FOO_INFO, BAR_INFO, BAZ_INFO],
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(results?.map((entry) => entry.pkg)).toStrictEqual([
			"@halcyon/foo",
			"@halcyon/bar",
			"@halcyon/baz",
		]);
		expect(results?.[0]?.displayName).toBe("@halcyon/foo");
		expect(results?.[1]?.result.exitCode).toBe(1);
		expect(results?.[2]?.result.exitCode).toBe(0);
	});

	it("should surface preflight errors and skip the backend", async () => {
		expect.assertions(2);

		vol.reset();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		vol.fromJSON({
			[path.join(BAR_DIR, "package.json")]: packageJson({ name: "@halcyon/bar" }),
			[path.join(FOO_DIR, "package.json")]: packageJson({ name: "@halcyon/foo" }),
			[path.join(FOO_DIR, "test.project.json")]: packageJson({
				name: "foo-test",
				tree: { $className: "DataModel" },
			}),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		const { backend } = createStubBackend([]);

		const results = await runWorkspace({
			backend,
			cli: makeCli(),
			config: makeConfig(),
			packageInfos: [FOO_INFO, BAR_INFO],
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(results).toBeUndefined();
		expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/@halcyon\/bar/));
	});

	it("should auto-create $path directories that have child entries even with extension", async () => {
		expect.assertions(2);

		vol.reset();
		vol.fromJSON({
			[path.join(FOO_DIR, "package.json")]: packageJson({ name: "@halcyon/foo" }),
			// Pre-existing leaf-file mount lets ensure-paths see a $path with
			// extension and no children — should NOT be created as a directory.
			[path.join(FOO_DIR, "src/init.luau")]: "return {}",
			[path.join(FOO_DIR, "test.project.json")]: packageJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						Container: {
							$path: "src/has.dot",
							Inner: { $className: "Folder" },
						},
						Leaf: { $path: "src/init.luau" },
					},
				},
			}),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		const projects = fromAny([
			{ test: { displayName: "main", include: ["src/has.dot/**/*.spec.luau"] } },
		]);
		setLoadedConfigPerPackage({
			[FOO_DIR]: { ...DEFAULT_CONFIG, projects, rootDir: FOO_DIR },
		});

		const { backend } = createStubBackend([]);

		await runWorkspace({
			backend,
			cli: makeCli(),
			config: makeConfig({ passWithNoTests: true }),
			packageInfos: [FOO_INFO],
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(vol.existsSync(path.join(FOO_DIR, "src/has.dot"))).toBeTrue();
		// init.luau wasn't directory-created (would clobber the existing file).
		expect(vol.statSync(path.join(FOO_DIR, "src/init.luau")).isFile()).toBeTrue();
	});

	it("should include dotted-name directories as virtual-wrap mounts", async () => {
		expect.assertions(1);

		vol.reset();
		vol.fromJSON({
			[path.join(FOO_DIR, "package.json")]: packageJson({ name: "@halcyon/foo" }),
			[path.join(FOO_DIR, "src/has.dot/spec.spec.luau")]: "",
			[path.join(FOO_DIR, "test.project.json")]: packageJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Container: { $path: "src/has.dot" } },
				},
			}),
			...emptyJestConfig(FOO_DIR),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		setLoadedConfigPerPackage({
			[FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR },
		});

		const { backend, captured } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "@halcyon/foo" },
		]);

		await runWorkspace({
			backend,
			cli: makeCli(),
			config: makeConfig(),
			packageInfos: [FOO_INFO],
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		// The virtual-wrap project must include the dotted-name directory
		// mount; without the fix the directory is mis-classified as a file
		// and produces zero jobs.
		expect(captured.options?.jobs).toHaveLength(1);
	});

	it("should defer malformed rojo project to preflight without crashing ensure-paths", async () => {
		expect.assertions(2);

		vol.reset();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		vol.fromJSON({
			[path.join(FOO_DIR, "package.json")]: packageJson({ name: "@halcyon/foo" }),
			[path.join(FOO_DIR, "test.project.json")]: "not valid json {{",
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		const { backend } = createStubBackend([]);

		const results = await runWorkspace({
			backend,
			cli: makeCli(),
			config: makeConfig(),
			packageInfos: [FOO_INFO],
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(results).toBeUndefined();
		expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/failed to parse rojoProject/));
	});
});
