import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import type { Backend, BackendOptions, BackendResult } from "./backends/interface.ts";
import { loadConfig } from "./config/loader.ts";
import type { CliOptions, WorkspaceRunOptions } from "./config/schema.ts";
import { DEFAULT_CONFIG } from "./config/schema.ts";
import { MANIFEST_VERSION } from "./coverage/manifest.ts";
import { prepareWorkStealingQueue } from "./memory-store/work-stealing.ts";
import { createTimingCollector } from "./timing/orchestration-collector.ts";
import { buildWithRojo } from "./utils/rojo-builder.ts";
import { runWorkspace } from "./workspace-runner.ts";

vi.mock(import("./memory-store/work-stealing.ts"), () => {
	return {
		prepareWorkStealingQueue: vi.fn<typeof prepareWorkStealingQueue>(),
	};
});

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

vi.mock(import("./utils/rojo-builder.ts"));

vi.mock(import("./config/loader.ts"), async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, loadConfig: vi.fn<typeof actual.loadConfig>(actual.loadConfig) };
});

// rojo-utils is loaded only transitively (via ./workspace-runner.ts), never as a
// direct top-level import: this suite mocks node:fs, and loading the bundled
// rojo-utils module before the async node:fs mock resolves trips a hoisting TDZ.
// Tests grab RojoResolver via a (cached) dynamic import and spy on fromPath, so
// the real tree-walking helpers stay real while the filesystem walk is stubbed.

vi.mock(import("./coverage/workspace-prepare.ts"));

const ROOT = path.resolve("/repo");
const FOO_DIR = path.join(ROOT, "packages/foo");
const BAR_DIR = path.join(ROOT, "packages/bar");
const BAZ_DIR = path.join(ROOT, "packages/baz");
const FOO_INFO = { name: "@halcyon/foo", packageDirectory: FOO_DIR };
const BAR_INFO = { name: "@halcyon/bar", packageDirectory: BAR_DIR };
const BAZ_INFO = { name: "@halcyon/baz", packageDirectory: BAZ_DIR };

interface BackendStubEntry {
	gameOutput?: string;
	jestOutput: string;
	pkg?: string;
	project?: string;
	snapshotWrites?: Record<string, string>;
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
				rawResults: entries.map((entry) => {
					return {
						entry: {
							jestOutput: entry.jestOutput,
							...(entry.gameOutput !== undefined
								? { gameOutput: entry.gameOutput }
								: {}),
							...(entry.pkg !== undefined ? { pkg: entry.pkg } : {}),
							...(entry.project !== undefined ? { project: entry.project } : {}),
							...(entry.snapshotWrites !== undefined
								? { snapshotWrites: entry.snapshotWrites }
								: {}),
						},
					};
				}),
				timing: { executionMs: 0, uploadMs: 0 },
			};
		},
	};
	return { backend, captured };
}

function makeRunOptions(overrides: Partial<WorkspaceRunOptions> = {}): WorkspaceRunOptions {
	return {
		backend: DEFAULT_CONFIG.backend,
		color: DEFAULT_CONFIG.color,
		formatters: [],
		port: DEFAULT_CONFIG.port,
		silent: DEFAULT_CONFIG.silent,
		workspaceGameOutput: false,
		workspaceOutputFile: false,
		...overrides,
	};
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
			packageInfos: [FOO_INFO, BAR_INFO],
			runOptions: makeRunOptions(),
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(captured.options?.scriptOverride).toContain('"testTimeout":1234');
		expect(captured.options?.scriptOverride).toContain('"testTimeout":5678');
	});

	it("should forward a basename testPathPattern when --testPathPattern is a filesystem path", async () => {
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
			[FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR, testMatch: ["**/*.spec.luau"] },
		});

		const { backend, captured } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "@halcyon/foo" },
		]);

		await runWorkspace({
			backend,
			cli: makeCli({ testPathPattern: "src/foo.spec" }),
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(captured.options!.scriptOverride).toContain('"testPathPattern":"(foo\\\\.spec)"');
		expect(captured.options!.scriptOverride).not.toContain('"testPathPattern":"src/foo.spec"');
	});

	it("should pass with no tests in a package the testPathPattern does not match", async () => {
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
			[FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR, testMatch: ["**/*.spec.luau"] },
		});

		const { backend, captured } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "@halcyon/foo" },
		]);

		await runWorkspace({
			backend,
			cli: makeCli({ testPathPattern: "src/other-package.spec" }),
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(captured.options!.scriptOverride).toContain('"passWithNoTests":true');
		// The zero-matching pattern is intentionally retained (not cleared) so
		// the Luau side runs nothing instead of falling back to testMatch.
		expect(captured.options!.scriptOverride).toContain(
			'"testPathPattern":"src/other-package.spec"',
		);
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
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(captured.options?.scriptOverride).toContain('"project":"@halcyon/foo"');
		expect(results?.[0]?.displayName).toBe("@halcyon/foo");
	});

	it("should print a nested host [TIMING] report when TIMING is set", async () => {
		expect.assertions(4);

		vi.stubEnv("TIMING", "1");
		const writes: Array<string> = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			writes.push(String(chunk));
			return true;
		});

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

		const { backend } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "@halcyon/foo" },
		]);

		// Lifecycle (create + flush) moved to `runJestRoblox` so a single
		// collector covers single/multi/workspace modes. Tests that exercise
		// `runWorkspace` directly must own that lifecycle themselves.
		const timing = createTimingCollector();
		try {
			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions(),
				timing,
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});
		} finally {
			timing.flushTimingReport();
		}

		const timingLines = writes
			.join("")
			.split("\n")
			.filter((line) => line.startsWith("[TIMING]"));

		expect(timingLines).toContainEqual(
			expect.stringMatching(/^\[TIMING] loadPackages: \d+ms$/),
		);
		expect(timingLines).toContainEqual(
			expect.stringMatching(/^\[TIMING] {3}load-config:@halcyon\/foo: \d+ms$/),
		);
		expect(timingLines).toContainEqual(expect.stringMatching(/^\[TIMING] runProjects: \d+ms$/));
		expect(timingLines).toContainEqual(
			expect.stringMatching(/^\[TIMING] TOTAL \(host\): \d+ms$/),
		);
	});

	it("should still flush the [TIMING] report when a phase throws", async () => {
		expect.assertions(2);

		vi.stubEnv("TIMING", "1");
		const writes: Array<string> = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			writes.push(String(chunk));
			return true;
		});

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

		vi.mocked(buildWithRojo).mockImplementationOnce(() => {
			throw new Error("rojo boom");
		});

		const { backend } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "@halcyon/foo" },
		]);

		// Caller-owned try/finally must still flush — the test asserts the
		// host waterfall lands even when a profiled phase throws (lute
		// missing, rojo build failure, dispatch timeout).
		const timing = createTimingCollector();
		try {
			await expect(
				runWorkspace({
					backend,
					cli: makeCli(),
					packageInfos: [FOO_INFO],
					runOptions: makeRunOptions(),
					timing,
					version: "0.0.0-test",
					workspaceRoot: ROOT,
				}),
			).rejects.toThrow("rojo boom");
		} finally {
			timing.flushTimingReport();
		}

		const timingLines = writes
			.join("")
			.split("\n")
			.filter((line) => line.startsWith("[TIMING]"));

		expect(timingLines).toContainEqual(
			expect.stringMatching(/^\[TIMING] TOTAL \(host\): \d+ms$/),
		);
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
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(captured.options?.scriptOverride).toContain('"project":"client"');
		expect(captured.options?.scriptOverride).toContain('"project":"server"');
		expect(results?.map((entry) => entry.displayName)).toStrictEqual(["client", "server"]);
	});

	it("should pre-flight clean marker-bearing leftover stubs from package source and emit a stderr notice", async () => {
		expect.assertions(3);

		vol.reset();
		const leftoverStub = path.join(FOO_DIR, "out/Client/jest.config.luau");
		vol.fromJSON({
			...seedPackage(FOO_DIR, {
				name: "@halcyon/foo",
				specFiles: { [path.join(FOO_DIR, "out/Client/spec.spec.luau")]: "" },
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Client: { $path: "out/Client" } },
				},
			}),
			[leftoverStub]: "-- Auto-generated by jest-roblox (do not edit)\nreturn {}\n",
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

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		await runWorkspace({
			backend,
			cli: makeCli(),
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(vol.existsSync(leftoverStub)).toBeFalse();
		expect(stderr).toHaveBeenCalledWith(
			expect.stringContaining("cleaned 1 leftover stub(s) from @halcyon/foo"),
		);

		const writes = stderr.mock.calls.map((call) => call[0] as string).join("");

		expect(writes).toContain(leftoverStub);

		stderr.mockRestore();
	});

	it("should skip stubMounts construction for mounts that already have a user-authored config on disk", async () => {
		expect.assertions(2);

		vol.reset();
		const userConfigPath = path.join(FOO_DIR, "out/Client/jest.config.luau");
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
			// User-authored config (no marker) at the mount —
			// `hasUserAuthoredConfig` should return true and the stubMount
			// construction must skip it.
			[userConfigPath]: "return { displayName = 'user-shared' }\n",
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
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		// User file survives the run (cleanLeftoverStubs only touches markers).
		expect(vol.existsSync(userConfigPath)).toBeTrue();

		// And the cache stub was NOT written for that mount because
		// hasUserAuthoredConfig short-circuited generateProjectStubs.
		const cacheStub = path.join(
			ROOT,
			".jest-roblox/workspace/@halcyon/foo/out/Client/jest.config.luau",
		);

		expect(vol.existsSync(cacheStub)).toBeFalse();
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
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
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
			packageInfos: [FOO_INFO, BAR_INFO],
			runOptions: makeRunOptions(),
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
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
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
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions(),
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

		// Mock the RojoResolver so the resolver's filesystem walk is skipped and
		// these tests stay focused on workspace orchestration.
		const mapping: Record<string, Array<string>> = {
			[path.resolve(FOO_DIR, "./src/Shared/setup.luau")]: [
				"ReplicatedStorage",
				"Pkg",
				"Shared",
				"setup",
			],
		};
		const { RojoResolver } = await import("@isentinel/rojo-utils");
		vi.spyOn(RojoResolver, "fromPath").mockReturnValue(
			fromAny({
				getRbxPathFromFilePath(filePath: string) {
					return mapping[filePath];
				},
			}),
		);

		const { backend, captured } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "@halcyon/foo" },
		]);

		await runWorkspace({
			backend,
			cli: makeCli(),
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
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

	it("should not build a rojo resolver for packages without setup files", async () => {
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

		const { RojoResolver } = await import("@isentinel/rojo-utils");
		const fromPathSpy = vi.spyOn(RojoResolver, "fromPath");

		const { backend } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "@halcyon/foo" },
		]);

		await runWorkspace({
			backend,
			cli: makeCli(),
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		// No project declares setupFiles/setupFilesAfterEnv, so the costly
		// RojoResolver tree walk must be skipped entirely — it is the dominant
		// resolveContexts cost and resolves nothing here.
		expect(fromPathSpy).not.toHaveBeenCalled();
	});

	it("should resolve a project that declares only setupFiles", async () => {
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
			},
		});

		const { RojoResolver } = await import("@isentinel/rojo-utils");
		vi.spyOn(RojoResolver, "fromPath").mockReturnValue(
			fromAny({
				getRbxPathFromFilePath() {
					return ["ReplicatedStorage", "Pkg", "Shared", "setup"];
				},
			}),
		);

		const { backend, captured } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "@halcyon/foo" },
		]);

		await runWorkspace({
			backend,
			cli: makeCli(),
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(captured.options?.scriptOverride).toContain(
			'"setupFiles":["ReplicatedStorage/Pkg/Shared/setup"]',
		);
		expect(captured.options?.scriptOverride).not.toContain('"setupFilesAfterEnv"');
	});

	it("should resolve a project that declares only setupFilesAfterEnv", async () => {
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
				setupFilesAfterEnv: ["./src/Shared/setup.luau"],
			},
		});

		const { RojoResolver } = await import("@isentinel/rojo-utils");
		vi.spyOn(RojoResolver, "fromPath").mockReturnValue(
			fromAny({
				getRbxPathFromFilePath() {
					return ["ReplicatedStorage", "Pkg", "Shared", "setup"];
				},
			}),
		);

		const { backend, captured } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "@halcyon/foo" },
		]);

		await runWorkspace({
			backend,
			cli: makeCli(),
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(captured.options?.scriptOverride).toContain(
			'"setupFilesAfterEnv":["ReplicatedStorage/Pkg/Shared/setup"]',
		);
		expect(captured.options?.scriptOverride).not.toContain('"setupFiles":');
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
			packageInfos: [FOO_INFO, BAR_INFO],
			runOptions: makeRunOptions(),
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		// Both packages produce jobs because each package's own rojoProject
		// resolves correctly. Without the fix, Bar's preflight fails on the
		// non-existent test.project.json (the parent default).
		expect(captured.options?.jobs).toHaveLength(2);
		expect(results?.map((entry) => entry.pkg)).toStrictEqual(["@halcyon/foo", "@halcyon/bar"]);
	});

	it("should resolve a Nevermore-style subdir rojoProject that mounts the package via '..'", async () => {
		expect.assertions(2);

		vol.reset();
		vol.fromJSON({
			// Package manifest maps src to the tree root (standard Wally layout).
			[path.join(FOO_DIR, "default.project.json")]: packageJson({
				name: "foo",
				tree: { $path: "src" },
			}),
			[path.join(FOO_DIR, "jest.config.ts")]: "export default {}",
			[path.join(FOO_DIR, "package.json")]: packageJson({ name: "@halcyon/foo" }),
			[path.join(FOO_DIR, "src/foo.spec.lua")]: "",
			// Test harness lives in a subdirectory and mounts the package via
			// "..", which Rojo resolves through the package default.project.json.
			[path.join(FOO_DIR, "test/default.project.json")]: packageJson({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ServerScriptService: { Pkg: { $path: ".." } },
				},
			}),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		const projects = fromAny([
			{ test: { displayName: "@halcyon/foo", include: ["src/**/*.spec.lua"] } },
		]);
		setLoadedConfigPerPackage({
			[FOO_DIR]: {
				...DEFAULT_CONFIG,
				projects,
				rojoProject: "test/default.project.json",
				rootDir: FOO_DIR,
			},
		});

		const { backend, captured } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "@halcyon/foo" },
		]);

		const results = await runWorkspace({
			backend,
			cli: makeCli(),
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		// The "src" include root (package-relative) resolves through the
		// package's default.project.json into the ServerScriptService/Pkg mount
		// declared by the subdirectory test project.
		expect(captured.options?.scriptOverride).toContain(
			'"projects":["ServerScriptService/Pkg"]',
		);
		expect(results?.[0]?.displayName).toBe("@halcyon/foo");
	});

	// Workspace-root `config.rojoProject` no longer falls back into
	// per-package descriptor resolution. Each package must declare its own
	// rojoProject (directly or via extends); the workspace-root config
	// silently dropping a custom value into per-pkg lookups was the same
	// "workspace-root vs per-pkg" leak as the other A2 sites.
	it("should NOT fall back to workspace-root config.rojoProject when the package config omits it", async () => {
		expect.assertions(1);

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
			[path.join(BAR_DIR, "package.json")]: packageJson({ name: "@halcyon/bar" }),
			[path.join(BAR_DIR, "src/bar.spec.luau")]: "",
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		// Bar's per-pkg config has no rojoProject — previously the middle
		// arm of `pkg ?? config ?? DEFAULT` would pick up the workspace-root
		// value below and resolve "custom.project.json". After the collapse,
		// resolution falls straight to `ROJO_PROJECT_DEFAULT`
		// ("test.project.json") — which does not exist at BAR_DIR, so preflight
		// fails.
		setLoadedConfigPerPackage({
			[BAR_DIR]: { ...DEFAULT_CONFIG, rootDir: BAR_DIR },
		});

		const { backend } = createStubBackend([]);

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const results = await runWorkspace({
			backend,
			cli: makeCli(),
			packageInfos: [BAR_INFO],
			runOptions: makeRunOptions(),
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		stderr.mockRestore();

		expect(results).toBeUndefined();
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
			[BAR_DIR]: { ...DEFAULT_CONFIG, passWithNoTests: true, rootDir: BAR_DIR },
			[FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR },
		});

		const { backend, captured } = createStubBackend([
			{ jestOutput: passingResult(), pkg: "@halcyon/foo", project: "@halcyon/foo" },
		]);

		const results = await runWorkspace({
			backend,
			cli: makeCli(),
			packageInfos: [FOO_INFO, BAR_INFO],
			runOptions: makeRunOptions(),
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
			[FOO_DIR]: { ...DEFAULT_CONFIG, passWithNoTests: true, rootDir: FOO_DIR },
		});

		const { backend } = createStubBackend([]);

		const results = await runWorkspace({
			backend,
			cli: makeCli(),
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(results).toStrictEqual([]);
	});

	it("should honor per-package passWithNoTests when the workspace config does not set it", async () => {
		expect.assertions(1);

		vol.reset();
		vol.fromJSON({
			...seedPackage(FOO_DIR, { name: "@halcyon/foo" }),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		// Package opts in to passWithNoTests via its OWN jest.config; the
		// workspace-level config has no real global. Workspace mode must
		// consult the per-package value, not aggregate over the workspace
		// root.
		setLoadedConfigPerPackage({
			[FOO_DIR]: { ...DEFAULT_CONFIG, passWithNoTests: true, rootDir: FOO_DIR },
		});

		const { backend } = createStubBackend([]);

		const results = await runWorkspace({
			backend,
			cli: makeCli(),
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(results).toStrictEqual([]);
	});

	it("should error when one package has zero tests and its own passWithNoTests is false even if another package opts in", async () => {
		expect.assertions(3);

		vol.reset();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		vol.fromJSON({
			...seedPackage(FOO_DIR, { name: "@halcyon/foo" }),
			...seedPackage(BAR_DIR, { name: "@halcyon/bar" }),
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});

		setLoadedConfigPerPackage({
			[BAR_DIR]: { ...DEFAULT_CONFIG, rootDir: BAR_DIR },
			[FOO_DIR]: { ...DEFAULT_CONFIG, passWithNoTests: true, rootDir: FOO_DIR },
		});

		const { backend } = createStubBackend([]);

		const results = await runWorkspace({
			backend,
			cli: makeCli(),
			packageInfos: [FOO_INFO, BAR_INFO],
			runOptions: makeRunOptions(),
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(results).toBeUndefined();
		expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/@halcyon\/bar/));
		expect(stderr).not.toHaveBeenCalledWith(expect.stringMatching(/@halcyon\/foo/));
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
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(results).toBeUndefined();
		expect(stderr).toHaveBeenCalledWith(
			expect.stringMatching(/No test files found in package @halcyon\/foo/),
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
			packageInfos: [FOO_INFO, BAR_INFO, BAZ_INFO],
			runOptions: makeRunOptions(),
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
			packageInfos: [FOO_INFO, BAR_INFO],
			runOptions: makeRunOptions(),
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
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
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
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
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
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions(),
			version: "0.0.0-test",
			workspaceRoot: ROOT,
		});

		expect(results).toBeUndefined();
		expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/failed to parse rojoProject/));
	});

	describe("coverage", () => {
		it("should call prepareWorkspaceCoverage with the workspace packages when collectCoverage is set", async () => {
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
				[FOO_DIR]: { ...DEFAULT_CONFIG, collectCoverage: true, rootDir: FOO_DIR },
			});

			const { prepareWorkspaceCoverage } = await import("./coverage/workspace-prepare.ts");
			vi.mocked(prepareWorkspaceCoverage).mockReturnValue([
				{
					coverageRoots: [{ luauRoot: "src", shadowDir: "/shadow/src" }],
					manifest: {
						buildId: "test-build-id",
						files: {},
						generatedAt: "x",
						instrumenterVersion: 2,
						luauRoots: [],
						nonInstrumentedFiles: {},
						shadowDir: "/shadow",
						version: MANIFEST_VERSION,
					},
					manifestPath: "/shadow/coverage-manifest.json",
					pkg: "@halcyon/foo",
				},
			]);

			const { backend } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli({ collectCoverage: true }),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions(),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			expect(prepareWorkspaceCoverage).toHaveBeenCalledOnce();

			const callArgs = vi.mocked(prepareWorkspaceCoverage).mock.calls[0]![0];

			expect(callArgs.packages.map((entry) => entry.name)).toStrictEqual(["@halcyon/foo"]);
		});

		// The per-package coverage knobs must reach the descriptor so
		// `prepareWorkspaceCoverage`'s discovery and ignore-matcher both see the
		// merged pkgConfig values. Pre-fix `loadPackages` only populated
		// `name`/`packageDirectory`/`rojoProjectPath` and silently dropped
		// `luauRoots` + `coveragePathIgnorePatterns`.
		it("should propagate pkgConfig luauRoots and coveragePathIgnorePatterns onto the descriptor", async () => {
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
				[FOO_DIR]: {
					...DEFAULT_CONFIG,
					collectCoverage: true,
					coveragePathIgnorePatterns: ["**/vendored-packages/**"],
					luauRoots: ["src"],
					rootDir: FOO_DIR,
				},
			});

			const { prepareWorkspaceCoverage } = await import("./coverage/workspace-prepare.ts");
			vi.mocked(prepareWorkspaceCoverage).mockReturnValue([
				{
					coverageRoots: [{ luauRoot: "src", shadowDir: "/shadow/src" }],
					manifest: {
						buildId: "test-build-id",
						files: {},
						generatedAt: "x",
						instrumenterVersion: 2,
						luauRoots: [],
						nonInstrumentedFiles: {},
						shadowDir: "/shadow",
						version: MANIFEST_VERSION,
					},
					manifestPath: "/shadow/coverage-manifest.json",
					pkg: "@halcyon/foo",
				},
			]);

			const { backend } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli({ collectCoverage: true }),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions(),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			const callArgs = vi.mocked(prepareWorkspaceCoverage).mock.calls[0]![0];
			const descriptor = callArgs.packages[0]!;

			expect(descriptor.luauRoots).toStrictEqual(["src"]);
			expect(descriptor.coveragePathIgnorePatterns).toStrictEqual([
				"**/vendored-packages/**",
			]);
		});

		// Follow-up: the descriptor must distinguish "user set
		// coveragePathIgnorePatterns" from "default value present after merge"
		// — otherwise every package looks like an override and the workspace
		// root's custom patterns silently never apply. `resolveConfig`
		// (loader.ts:42) preserves the `DEFAULT_CONFIG` array reference when
		// the package config omits the key, so reference identity gates the
		// descriptor field.
		// Per-pkg `coverageCache` reaches the descriptor so the
		// cache gate in `prepareWorkspaceCoverage` can honor an opt-out
		// declared in a package's own jest.config (or extended from
		// jest.shared.ts). The workspace-root config no longer drives this
		// knob.
		it("should propagate pkgConfig.coverageCache: false onto the descriptor", async () => {
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
				[FOO_DIR]: {
					...DEFAULT_CONFIG,
					collectCoverage: true,
					coverageCache: false,
					rootDir: FOO_DIR,
				},
			});

			const { prepareWorkspaceCoverage } = await import("./coverage/workspace-prepare.ts");
			vi.mocked(prepareWorkspaceCoverage).mockReturnValue([
				{
					coverageRoots: [{ luauRoot: "src", shadowDir: "/shadow/src" }],
					manifest: {
						buildId: "test-build-id",
						files: {},
						generatedAt: "x",
						instrumenterVersion: 2,
						luauRoots: [],
						nonInstrumentedFiles: {},
						shadowDir: "/shadow",
						version: MANIFEST_VERSION,
					},
					manifestPath: "/shadow/coverage-manifest.json",
					pkg: "@halcyon/foo",
				},
			]);

			const { backend } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli({ collectCoverage: true }),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions(),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			const callArgs = vi.mocked(prepareWorkspaceCoverage).mock.calls[0]![0];
			const descriptor = callArgs.packages[0]!;

			expect(descriptor.coverageCache).toBeFalse();
		});

		it("should leave descriptor.coveragePathIgnorePatterns undefined when the package config defaults", async () => {
			expect.assertions(1);

			vol.reset();
			vol.fromJSON({
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
				}),
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});

			// Spread DEFAULT_CONFIG without overriding coveragePathIgnorePatterns
			// — the field keeps the DEFAULT_CONFIG reference verbatim, which
			// the loadPackages gate treats as "inherit root".
			setLoadedConfigPerPackage({
				[FOO_DIR]: { ...DEFAULT_CONFIG, collectCoverage: true, rootDir: FOO_DIR },
			});

			const { prepareWorkspaceCoverage } = await import("./coverage/workspace-prepare.ts");
			vi.mocked(prepareWorkspaceCoverage).mockReturnValue([
				{
					coverageRoots: [{ luauRoot: "src", shadowDir: "/shadow/src" }],
					manifest: {
						buildId: "test-build-id",
						files: {},
						generatedAt: "x",
						instrumenterVersion: 2,
						luauRoots: [],
						nonInstrumentedFiles: {},
						shadowDir: "/shadow",
						version: MANIFEST_VERSION,
					},
					manifestPath: "/shadow/coverage-manifest.json",
					pkg: "@halcyon/foo",
				},
			]);

			const { backend } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli({ collectCoverage: true }),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions(),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			const callArgs = vi.mocked(prepareWorkspaceCoverage).mock.calls[0]![0];
			const descriptor = callArgs.packages[0]!;

			expect(descriptor.coveragePathIgnorePatterns).toBeUndefined();
		});

		it("should embed _coverage in the materializer config when collectCoverage is set", async () => {
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
				[FOO_DIR]: { ...DEFAULT_CONFIG, collectCoverage: true, rootDir: FOO_DIR },
			});

			const { prepareWorkspaceCoverage } = await import("./coverage/workspace-prepare.ts");
			vi.mocked(prepareWorkspaceCoverage).mockReturnValue([
				{
					coverageRoots: [],
					manifest: {
						buildId: "test-build-id",
						files: {},
						generatedAt: "x",
						instrumenterVersion: 2,
						luauRoots: [],
						nonInstrumentedFiles: {},
						shadowDir: "/shadow",
						version: MANIFEST_VERSION,
					},
					manifestPath: "/shadow/coverage-manifest.json",
					pkg: "@halcyon/foo",
				},
			]);

			const { backend, captured } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli({ collectCoverage: true }),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions(),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			expect(captured.options?.scriptOverride).toContain('"_coverage":true');
		});

		it("should expose per-package coverage descriptors on the workspace result", async () => {
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
				[FOO_DIR]: { ...DEFAULT_CONFIG, collectCoverage: true, rootDir: FOO_DIR },
			});

			const { prepareWorkspaceCoverage } = await import("./coverage/workspace-prepare.ts");
			const manifest = {
				buildId: "test-build-id",
				files: {},
				generatedAt: "x",
				instrumenterVersion: 2,
				luauRoots: [],
				nonInstrumentedFiles: {},
				shadowDir: "/shadow",
				version: MANIFEST_VERSION,
			};
			vi.mocked(prepareWorkspaceCoverage).mockReturnValue([
				{
					coverageRoots: [{ luauRoot: "src", shadowDir: "/shadow/src" }],
					manifest,
					manifestPath: "/shadow/coverage-manifest.json",
					pkg: "@halcyon/foo",
				},
			]);

			const { backend } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			const results = await runWorkspace({
				backend,
				cli: makeCli({ collectCoverage: true }),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions(),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			expect(results?.[0]?.coverageManifest).toBe(manifest);
			expect(results?.[0]?.pkg).toBe("@halcyon/foo");
		});

		it("should restrict prepareWorkspaceCoverage to packages with pending test files", async () => {
			expect.assertions(1);

			vol.reset();
			vol.fromJSON({
				// foo has a spec file
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
				}),
				// bar has NO spec files — should be excluded from instrumentation
				...seedPackage(BAR_DIR, {
					name: "@halcyon/bar",
					specFiles: {},
				}),
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});

			setLoadedConfigPerPackage({
				[BAR_DIR]: {
					...DEFAULT_CONFIG,
					collectCoverage: true,
					passWithNoTests: true,
					rootDir: BAR_DIR,
				},
				[FOO_DIR]: { ...DEFAULT_CONFIG, collectCoverage: true, rootDir: FOO_DIR },
			});

			const { prepareWorkspaceCoverage } = await import("./coverage/workspace-prepare.ts");
			vi.mocked(prepareWorkspaceCoverage).mockReturnValue([]);

			const { backend } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli({ collectCoverage: true }),
				packageInfos: [FOO_INFO, BAR_INFO],
				runOptions: makeRunOptions(),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			const callArgs = vi.mocked(prepareWorkspaceCoverage).mock.calls[0]![0];

			expect(callArgs.packages.map((entry) => entry.name)).toStrictEqual(["@halcyon/foo"]);
		});

		it("should not call prepareWorkspaceCoverage when collectCoverage is false", async () => {
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

			const { prepareWorkspaceCoverage } = await import("./coverage/workspace-prepare.ts");
			const { backend } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions(),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			expect(prepareWorkspaceCoverage).not.toHaveBeenCalled();
		});

		it("should honor per-package collectCoverage when the workspace config does not set it", async () => {
			expect.assertions(1);

			vol.reset();
			vol.fromJSON({
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
				}),
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});

			// Per-package opts in; workspace does not. The workspace runner
			// must still instrument so the materializer's runtime coverage
			// collection has a shadow dir to read from.
			setLoadedConfigPerPackage({
				[FOO_DIR]: { ...DEFAULT_CONFIG, collectCoverage: true, rootDir: FOO_DIR },
			});

			const { prepareWorkspaceCoverage } = await import("./coverage/workspace-prepare.ts");
			vi.mocked(prepareWorkspaceCoverage).mockReturnValue([]);

			const { backend } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions(),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			const callArgs = vi.mocked(prepareWorkspaceCoverage).mock.calls[0]?.[0];

			expect(callArgs?.packages.map((entry) => entry.name)).toStrictEqual(["@halcyon/foo"]);
		});

		it("should restrict prepareWorkspaceCoverage to packages that opted in via per-package collectCoverage", async () => {
			expect.assertions(1);

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
				[BAR_DIR]: { ...DEFAULT_CONFIG, rootDir: BAR_DIR },
				[FOO_DIR]: { ...DEFAULT_CONFIG, collectCoverage: true, rootDir: FOO_DIR },
			});

			const { prepareWorkspaceCoverage } = await import("./coverage/workspace-prepare.ts");
			vi.mocked(prepareWorkspaceCoverage).mockReturnValue([]);

			const { backend } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
				{ jestOutput: passingResult(), pkg: "@halcyon/bar" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO, BAR_INFO],
				runOptions: makeRunOptions(),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			const callArgs = vi.mocked(prepareWorkspaceCoverage).mock.calls[0]?.[0];

			expect(callArgs?.packages.map((entry) => entry.name)).toStrictEqual(["@halcyon/foo"]);
		});
	});

	describe("work-stealing", () => {
		const testCredentials = { apiKey: "test-key", universeId: "u-123" };

		function mockPreparedQueue(queueId: string): void {
			vi.mocked(prepareWorkStealingQueue).mockResolvedValue({
				invisibilityWindowSeconds: 90,
				queueId,
			});
		}

		it("should push every (pkg, project) onto the queue and pass workStealing to backend when parallel>1", async () => {
			expect.assertions(3);

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
				[BAR_DIR]: { ...DEFAULT_CONFIG, rootDir: BAR_DIR },
				[FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR },
			});

			mockPreparedQueue("queue-1");
			const { backend, captured } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
				{ jestOutput: passingResult(), pkg: "@halcyon/bar" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO, BAR_INFO],
				runOptions: makeRunOptions({ parallel: 2 }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
				workStealingCredentials: testCredentials,
			});

			expect(captured.options?.workStealing).toBeTrue();
			expect(captured.options?.parallel).toBe(2);

			const prepareCall = vi.mocked(prepareWorkStealingQueue).mock.calls[0]?.[0];

			expect(prepareCall?.packages).toIncludeAllMembers([
				{ pkg: "@halcyon/foo", project: "@halcyon/foo" },
				{ pkg: "@halcyon/bar", project: "@halcyon/bar" },
			]);
		});

		it("should embed the same queueId in the script as the queue pushes", async () => {
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

			mockPreparedQueue("specific-queue-id");
			const { backend, captured } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ parallel: 2 }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
				workStealingCredentials: testCredentials,
			});

			expect(captured.options?.scriptOverride).toContain('"queueId":"specific-queue-id"');
		});

		it("should keep the existing single-task path when parallel is unset", async () => {
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
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions(),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
				workStealingCredentials: testCredentials,
			});

			expect(captured.options?.workStealing).toBeUndefined();
			expect(vi.mocked(prepareWorkStealingQueue)).not.toHaveBeenCalled();
		});

		it("should keep the existing path when workStealingCredentials is not provided even with parallel>1", async () => {
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
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ parallel: 4 }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			expect(captured.options?.workStealing).toBeUndefined();
			expect(captured.options?.scriptOverride).not.toContain('"queueId"');
		});

		it("should forward workStealingCredentials.baseUrl into prepareWorkStealingQueue", async () => {
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

			mockPreparedQueue("queue-base-url");
			const { backend } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				// Exercise the streaming-side baseUrl plumbing on the same call;
				// keeps the SortedMap client constructor seeing the override
				// when work-stealing fires.
				onStreamingResult: () => {
					/* intentionally inert */
				},
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ parallel: 2 }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
				workStealingCredentials: { ...testCredentials, baseUrl: "http://127.0.0.1:4010" },
			});

			expect(vi.mocked(prepareWorkStealingQueue).mock.calls[0]?.[0]?.baseUrl).toBe(
				"http://127.0.0.1:4010",
			);
		});

		it("should provide a streaming reader and onPackageResult to the backend when onStreamingResult is set", async () => {
			expect.assertions(2);

			vol.reset();
			vol.fromJSON({
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
				}),
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});
			setLoadedConfigPerPackage({ [FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR } });

			mockPreparedQueue("queue-stream");
			const { backend, captured } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				onStreamingResult: () => {
					/* intentionally inert */
				},
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ parallel: 2 }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
				workStealingCredentials: testCredentials,
			});

			expect(captured.options?.streaming?.reader).toBeDefined();
			expect(captured.options?.streaming?.onPackageResult).toBeFunction();
		});

		it("should embed a sortedMapId in the work-stealing script when onStreamingResult is set", async () => {
			expect.assertions(1);

			vol.reset();
			vol.fromJSON({
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
				}),
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});
			setLoadedConfigPerPackage({ [FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR } });

			mockPreparedQueue("queue-stream");
			const { backend, captured } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				onStreamingResult: () => {
					/* intentionally inert */
				},
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ parallel: 2 }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
				workStealingCredentials: testCredentials,
			});

			expect(captured.options?.scriptOverride).toContain('"sortedMapId":');
		});

		it("should skip streaming setup when onStreamingResult is omitted (no SortedMap polling overhead)", async () => {
			expect.assertions(2);

			vol.reset();
			vol.fromJSON({
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
				}),
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});
			setLoadedConfigPerPackage({ [FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR } });

			mockPreparedQueue("queue-stream");
			const { backend, captured } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ parallel: 2 }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
				workStealingCredentials: testCredentials,
			});

			expect(captured.options?.streaming).toBeUndefined();
			expect(captured.options?.scriptOverride).not.toContain('"sortedMapId":');
		});

		it("should route streaming entries through the supplied onStreamingResult", async () => {
			expect.assertions(1);

			vol.reset();
			vol.fromJSON({
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
				}),
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});
			setLoadedConfigPerPackage({ [FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR } });

			mockPreparedQueue("queue-stream");
			const seen: Array<string> = [];
			const streamedEntry = {
				elapsedMs: 5,
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				pkg: "@halcyon/foo",
				project: "@halcyon/foo",
				success: true,
			};

			const { backend } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);
			// Wrap the stub so it invokes the streaming hook before returning,
			// simulating an entry observed mid-task.
			const wrappedBackend: Backend = {
				kind: "open-cloud",
				runTests: async (options) => {
					options.streaming?.onPackageResult(streamedEntry);
					return backend.runTests(options);
				},
			};

			await runWorkspace({
				backend: wrappedBackend,
				cli: makeCli(),
				onStreamingResult: (entry) => {
					seen.push(entry.pkg);
				},
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ parallel: 2 }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
				workStealingCredentials: testCredentials,
			});

			expect(seen).toStrictEqual(["@halcyon/foo"]);
		});
	});

	describe("per-package output files", () => {
		it("should write .jest-roblox/output/<pkg>--<project>.jest-output.log under the workspace root from final results", async () => {
			expect.assertions(2);

			vol.reset();
			vol.fromJSON({
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
				}),
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});
			setLoadedConfigPerPackage({ [FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR } });

			const { backend } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ workspaceOutputFile: true }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			const file = path.join(
				ROOT,
				".jest-roblox",
				"output",
				"@halcyon-foo--@halcyon-foo.jest-output.log",
			);

			expect(vol.existsSync(file)).toBeTrue();
			expect(JSON.parse(vol.readFileSync(file, "utf8") as string)).toMatchObject({
				numFailedTests: 0,
				numPassedTests: 1,
				success: true,
			});
		});

		it("should sanitize filesystem-unsafe characters in pkg/project segments", async () => {
			expect.assertions(1);

			vol.reset();
			vol.fromJSON({
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
				}),
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});
			setLoadedConfigPerPackage({ [FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR } });

			const { backend } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ workspaceOutputFile: true }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			// `@halcyon/foo` → `@halcyon-foo`; slashes and other unsafe chars
			// become hyphens so the path component stays a single segment.
			expect(
				vol.existsSync(
					path.join(
						ROOT,
						".jest-roblox",
						"output",
						"@halcyon-foo--@halcyon-foo.jest-output.log",
					),
				),
			).toBeTrue();
		});

		it("should NOT write per-package result files when workspace.outputFile is disabled", async () => {
			expect.assertions(1);

			vol.reset();
			vol.fromJSON({
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
				}),
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});
			setLoadedConfigPerPackage({ [FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR } });

			const { backend } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions(),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			expect(
				vol.existsSync(
					path.join(
						ROOT,
						".jest-roblox",
						"output",
						"@halcyon-foo--@halcyon-foo.jest-output.log",
					),
				),
			).toBeFalse();
		});
	});

	describe("per-package gameOutput files", () => {
		it("should write parsed entries to .jest-roblox/output/<pkg>--<project>.game-output.log when workspace.gameOutput is enabled", async () => {
			expect.assertions(2);

			vol.reset();
			vol.fromJSON({
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
				}),
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});
			setLoadedConfigPerPackage({ [FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR } });

			const gameOutputRaw = JSON.stringify([
				{ message: "hello", messageType: 0, timestamp: 1000 },
			]);
			const { backend } = createStubBackend([
				{ gameOutput: gameOutputRaw, jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ workspaceGameOutput: true }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			const file = path.join(
				ROOT,
				".jest-roblox",
				"output",
				"@halcyon-foo--@halcyon-foo.game-output.log",
			);

			expect(vol.existsSync(file)).toBeTrue();
			expect(JSON.parse(vol.readFileSync(file, "utf8") as string)).toStrictEqual([
				{ message: "hello", messageType: 0, timestamp: 1000 },
			]);
		});

		it("should NOT write per-package gameOutput files when workspace.gameOutput is disabled", async () => {
			expect.assertions(2);

			vol.reset();
			vol.fromJSON({
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
				}),
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});
			setLoadedConfigPerPackage({ [FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR } });

			const gameOutputRaw = JSON.stringify([
				{ message: "hello", messageType: 0, timestamp: 1000 },
			]);
			const { backend } = createStubBackend([
				{ gameOutput: gameOutputRaw, jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ workspaceOutputFile: true }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			// The two per-package sinks are independent: with
			// workspace.outputFile on, the result JSON sibling is emitted, but
			// the .game-output.log companion stays absent because
			// workspace.gameOutput is off.
			expect(
				vol.existsSync(
					path.join(
						ROOT,
						".jest-roblox",
						"output",
						"@halcyon-foo--@halcyon-foo.jest-output.log",
					),
				),
			).toBeTrue();
			expect(
				vol.existsSync(
					path.join(
						ROOT,
						".jest-roblox",
						"output",
						"@halcyon-foo--@halcyon-foo.game-output.log",
					),
				),
			).toBeFalse();
		});

		it("should write an empty array when the package's gameOutput is missing", async () => {
			expect.assertions(1);

			vol.reset();
			vol.fromJSON({
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
				}),
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});
			setLoadedConfigPerPackage({ [FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR } });

			const { backend } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ workspaceGameOutput: true }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			const file = path.join(
				ROOT,
				".jest-roblox",
				"output",
				"@halcyon-foo--@halcyon-foo.game-output.log",
			);

			expect(JSON.parse(vol.readFileSync(file, "utf8") as string)).toStrictEqual([]);
		});

		it("should write an empty array when the package's gameOutput is invalid JSON", async () => {
			expect.assertions(1);

			vol.reset();
			vol.fromJSON({
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
				}),
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});
			setLoadedConfigPerPackage({ [FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR } });

			const { backend } = createStubBackend([
				{ gameOutput: "not-json", jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ workspaceGameOutput: true }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			const file = path.join(
				ROOT,
				".jest-roblox",
				"output",
				"@halcyon-foo--@halcyon-foo.game-output.log",
			);

			expect(JSON.parse(vol.readFileSync(file, "utf8") as string)).toStrictEqual([]);
		});

		// A failure envelope synthesizes an ExecuteResult
		// via executor.ts:482 carrying the per-entry gameOutput, so the
		// failed package's captured logs are NOT lost.
		it("should still write per-package gameOutput files when one entry's envelope is a failure", async () => {
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
				[BAR_DIR]: { ...DEFAULT_CONFIG, rootDir: BAR_DIR, silent: true },
				[FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR, silent: true },
			});

			const failureEnvelope = JSON.stringify({
				err: "Exited with code: 1",
				success: false,
			});
			const fooGameOutput = JSON.stringify([
				{ message: "captured before crash", messageType: 2, timestamp: 5 },
			]);

			const { backend } = createStubBackend([
				{ gameOutput: fooGameOutput, jestOutput: failureEnvelope, pkg: "@halcyon/foo" },
				{ jestOutput: passingResult(), pkg: "@halcyon/bar" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO, BAR_INFO],
				runOptions: makeRunOptions({ silent: true, workspaceGameOutput: true }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			const fooFile = path.join(
				ROOT,
				".jest-roblox",
				"output",
				"@halcyon-foo--@halcyon-foo.game-output.log",
			);
			const barFile = path.join(
				ROOT,
				".jest-roblox",
				"output",
				"@halcyon-bar--@halcyon-bar.game-output.log",
			);

			expect(JSON.parse(vol.readFileSync(fooFile, "utf8") as string)).toStrictEqual([
				{ message: "captured before crash", messageType: 2, timestamp: 5 },
			]);
			expect(JSON.parse(vol.readFileSync(barFile, "utf8") as string)).toStrictEqual([]);
		});

		it("should emit a separate gameOutput file per project for multi-project packages", async () => {
			expect.assertions(4);

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

			const clientOutput = JSON.stringify([
				{ message: "client", messageType: 0, timestamp: 1 },
			]);
			const serverOutput = JSON.stringify([
				{ message: "server", messageType: 1, timestamp: 2 },
			]);
			const { backend } = createStubBackend([
				{
					gameOutput: clientOutput,
					jestOutput: passingResult(),
					pkg: "@halcyon/foo",
					project: "client",
				},
				{
					gameOutput: serverOutput,
					jestOutput: passingResult(),
					pkg: "@halcyon/foo",
					project: "server",
				},
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ workspaceGameOutput: true }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			const clientFile = path.join(
				ROOT,
				".jest-roblox",
				"output",
				"@halcyon-foo--client.game-output.log",
			);
			const serverFile = path.join(
				ROOT,
				".jest-roblox",
				"output",
				"@halcyon-foo--server.game-output.log",
			);

			expect(vol.existsSync(clientFile)).toBeTrue();
			expect(vol.existsSync(serverFile)).toBeTrue();
			expect(JSON.parse(vol.readFileSync(clientFile, "utf8") as string)).toStrictEqual([
				{ message: "client", messageType: 0, timestamp: 1 },
			]);
			expect(JSON.parse(vol.readFileSync(serverFile, "utf8") as string)).toStrictEqual([
				{ message: "server", messageType: 1, timestamp: 2 },
			]);
		});
	});

	describe("aggregated gameOutput", () => {
		function seedFoo(): void {
			vol.reset();
			vol.fromJSON({
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
				}),
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});
			setLoadedConfigPerPackage({ [FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR } });
		}

		const helloRaw = JSON.stringify([{ message: "hello", messageType: 0, timestamp: 1000 }]);
		const aggregateFile = path.join(ROOT, "game-output.log");
		const perPackageFile = path.join(
			ROOT,
			".jest-roblox",
			"output",
			"@halcyon-foo--@halcyon-foo.game-output.log",
		);

		it("should write a single grouped aggregate file when runOptions.gameOutput is set", async () => {
			expect.assertions(1);

			seedFoo();
			const { backend } = createStubBackend([
				{ gameOutput: helloRaw, jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ gameOutput: aggregateFile, silent: true }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			expect(JSON.parse(vol.readFileSync(aggregateFile, "utf8") as string)).toStrictEqual([
				{
					entries: [{ message: "hello", messageType: 0, timestamp: 1000 }],
					package: "@halcyon/foo",
					project: "@halcyon/foo",
				},
			]);
		});

		it("should write both the aggregate and per-package files when both are enabled", async () => {
			expect.assertions(2);

			seedFoo();
			const { backend } = createStubBackend([
				{ gameOutput: helloRaw, jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({
					gameOutput: aggregateFile,
					silent: true,
					workspaceGameOutput: true,
				}),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			expect(vol.existsSync(aggregateFile)).toBeTrue();
			expect(vol.existsSync(perPackageFile)).toBeTrue();
		});

		it("should announce only the aggregate to humans when both sinks are active", async () => {
			expect.assertions(2);

			seedFoo();
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const { backend } = createStubBackend([
				{ gameOutput: helloRaw, jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({
					formatters: ["default"],
					gameOutput: aggregateFile,
					workspaceGameOutput: true,
				}),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(aggregateFile));
			expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining(perPackageFile));
		});

		it("should announce per-package files to agents when both sinks are active", async () => {
			expect.assertions(2);

			seedFoo();
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const { backend } = createStubBackend([
				{ gameOutput: helloRaw, jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({
					formatters: ["agent"],
					gameOutput: aggregateFile,
					workspaceGameOutput: true,
				}),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(perPackageFile));
			expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining(aggregateFile));
		});

		it("should announce per-package paths to humans when only per-package is active", async () => {
			expect.assertions(1);

			seedFoo();
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const { backend } = createStubBackend([
				{ gameOutput: helloRaw, jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ formatters: ["default"], workspaceGameOutput: true }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(perPackageFile));
		});

		it("should announce the aggregate to agents when only the aggregate is active", async () => {
			expect.assertions(1);

			seedFoo();
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const { backend } = createStubBackend([
				{ gameOutput: helloRaw, jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ formatters: ["agent"], gameOutput: aggregateFile }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(aggregateFile));
		});

		it("should not announce the aggregate when it captured zero entries", async () => {
			expect.assertions(2);

			seedFoo();
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const { backend } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ formatters: ["default"], gameOutput: aggregateFile }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			// File still written (empty group), but no notice for zero entries.
			expect(vol.existsSync(aggregateFile)).toBeTrue();
			expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining(aggregateFile));
		});
	});

	describe("aggregated outputFile", () => {
		it("should write the merged result to runOptions.outputFile", async () => {
			expect.assertions(2);

			vol.reset();
			vol.fromJSON({
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
				}),
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});
			setLoadedConfigPerPackage({ [FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR } });

			const { backend } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);
			const outputFile = path.join(ROOT, "jest-output.log");

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ outputFile, silent: true }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			expect(vol.existsSync(outputFile)).toBeTrue();
			expect(JSON.parse(vol.readFileSync(outputFile, "utf8") as string)).toMatchObject({
				numPassedTests: 1,
				success: true,
			});
		});

		it("should not write a result file when runOptions.outputFile is unset", async () => {
			expect.assertions(1);

			vol.reset();
			vol.fromJSON({
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: { [path.join(FOO_DIR, "src/foo.spec.luau")]: "" },
				}),
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});
			setLoadedConfigPerPackage({ [FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR } });

			const { backend } = createStubBackend([
				{ jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ silent: true }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			expect(vol.existsSync(path.join(ROOT, "jest-output.log"))).toBeFalse();
		});
	});

	describe("snapshot writeback", () => {
		it("should route each package's envelope snapshotWrites to its own package directory without cross-package leak", async () => {
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
				[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
			});

			setLoadedConfigPerPackage({
				[BAR_DIR]: { ...DEFAULT_CONFIG, rootDir: BAR_DIR, silent: true },
				[FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR, silent: true },
			});

			const { backend } = createStubBackend([
				{
					jestOutput: passingResult(),
					pkg: "@halcyon/foo",
					snapshotWrites: {
						"ReplicatedStorage/Pkg/__snapshots__/foo.spec.snap.luau":
							"foo-snap-content",
					},
				},
				{
					jestOutput: passingResult(),
					pkg: "@halcyon/bar",
					snapshotWrites: {
						"ReplicatedStorage/Pkg/__snapshots__/bar.spec.snap.luau":
							"bar-snap-content",
					},
				},
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO, BAR_INFO],
				runOptions: makeRunOptions({ silent: true }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			const fooSnap = path.join(FOO_DIR, "src/__snapshots__/foo.spec.snap.luau");
			const barSnap = path.join(BAR_DIR, "src/__snapshots__/bar.spec.snap.luau");

			expect(vol.readFileSync(fooSnap, "utf8")).toBe("foo-snap-content");
			expect(vol.readFileSync(barSnap, "utf8")).toBe("bar-snap-content");

			// No cross-package leak: foo's snapshot path does not appear under
			// bar's tree, and vice versa.
			expect(
				vol.existsSync(path.join(BAR_DIR, "src/__snapshots__/foo.spec.snap.luau")),
			).toBeFalse();
			expect(
				vol.existsSync(path.join(FOO_DIR, "src/__snapshots__/bar.spec.snap.luau")),
			).toBeFalse();
		});

		// When one entry's jestOutput is a failure envelope
		// (`{success:false, err:...}`) — the shape `runEntry`'s per-entry
		// pcall emits when Jest's `exit(1)` fires from the no-tests-found path
		// — the other entries' snapshots and per-package output files must
		// still be written. Previously runProjects's `Array.map` threw on the
		// first failure envelope (parser.ts:304 throws LuauScriptError) and
		// halted before reaching workspace-runner.ts:229
		// `writePerPackageOutputFiles`, dropping every captured snapshot.
		it("should still write sibling snapshots and per-package outputs when one entry's envelope is a failure", async () => {
			expect.assertions(5);

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
				[BAR_DIR]: { ...DEFAULT_CONFIG, rootDir: BAR_DIR, silent: true },
				[FOO_DIR]: { ...DEFAULT_CONFIG, rootDir: FOO_DIR, silent: true },
			});

			const failureEnvelope = JSON.stringify({
				err: "Exited with code: 1",
				success: false,
			});

			const { backend } = createStubBackend([
				{
					jestOutput: failureEnvelope,
					pkg: "@halcyon/foo",
				},
				{
					jestOutput: passingResult(),
					pkg: "@halcyon/bar",
					snapshotWrites: {
						"ReplicatedStorage/Pkg/__snapshots__/bar.spec.snap.luau":
							"bar-snap-content",
					},
				},
			]);

			await runWorkspace({
				backend,
				cli: makeCli(),
				packageInfos: [FOO_INFO, BAR_INFO],
				runOptions: makeRunOptions({ silent: true, workspaceOutputFile: true }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			});

			// bar's snapshot lands even though foo's envelope failed.
			expect(
				vol.readFileSync(
					path.join(BAR_DIR, "src/__snapshots__/bar.spec.snap.luau"),
					"utf8",
				),
			).toBe("bar-snap-content");

			// Per-package output files for BOTH packages get written. foo's
			// file documents the failure; bar's documents the pass.
			const fooOutput = path.join(
				ROOT,
				".jest-roblox",
				"output",
				"@halcyon-foo--@halcyon-foo.jest-output.log",
			);
			const barOutput = path.join(
				ROOT,
				".jest-roblox",
				"output",
				"@halcyon-bar--@halcyon-bar.jest-output.log",
			);

			expect(vol.existsSync(fooOutput)).toBeTrue();
			expect(vol.existsSync(barOutput)).toBeTrue();
			expect(JSON.parse(vol.readFileSync(fooOutput, "utf8") as string)).toMatchObject({
				success: false,
			});
			expect(JSON.parse(vol.readFileSync(barOutput, "utf8") as string)).toMatchObject({
				numPassedTests: 1,
				success: true,
			});
		});
	});
});
