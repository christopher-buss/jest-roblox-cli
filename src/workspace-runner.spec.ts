import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import type { Except } from "type-fest";
import { assert, describe, expect, it, vi } from "vitest";

import { createLuteChildProcess } from "#test/mocks/lute-child-process.ts";
import type { MemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { movableClockCollector } from "#test/mocks/movable-clock.ts";
import { posixRoot } from "#test/mocks/posix-path.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { configErrorLike } from "#test/mocks/run-config-error.ts";
import { MANIFEST_VERSION } from "#test/mocks/run-constants.ts";
import { recordingTimingCollector } from "#test/mocks/workspace-timing-recorder.ts";
import type {
	Backend,
	BackendOptions,
	BackendResult,
	EnvelopeEntry,
} from "./backends/interface.ts";
import type { PackageConfigLoader } from "./config/loader.ts";
import type {
	CliOptions,
	ProjectEntry,
	ResolvedConfig,
	WorkspaceRunOptions,
} from "./config/schema.ts";
import type { WorkspacePackageCoverage } from "./coverage-pipeline/workspace-prepare.ts";
import type { prepareWorkStealingQueueAsync } from "./memory-store/work-stealing.ts";
import type { runTypecheckAsync } from "./typecheck/runner.ts";
import type { JestResult } from "./types/jest-result-types.ts";
import type { ChildProcessRunner } from "./utils/child-process.ts";
import type { FileSystem } from "./utils/file-system.ts";
import type { RojoResolverFactory } from "./utils/rojo-project-reader.ts";
import type { WorkspaceProjectResult, WorkspaceRunnerOutput } from "./workspace-runner.ts";
import { runWorkspaceAsync } from "./workspace-runner.ts";
import type { PrepareCoverage } from "./workspace/coverage-attach.ts";

function resolverReturning(mapping: Record<string, Array<string>>): RojoResolverFactory {
	return () => {
		return fromAny({
			getRbxPathFromFilePath(filePath: string) {
				return mapping[filePath];
			},
		});
	};
}

const ROOT = path.resolve("/repo");
const WORKSPACE_CACHE = path.join(ROOT, ".jest-roblox", "workspace");
const SYNTHESIZED_PROJECT = path.join(WORKSPACE_CACHE, "synthesized.project.json");
/** Beside the place the run builds, named after it. */
const CODE_BUNDLE = path.join(WORKSPACE_CACHE, "synthesized.code-bundle.json");
const PLACE_BYTES = "RBXL-BYTES";
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

type PreResolutionConfig = Except<ResolvedConfig, "projects"> & {
	projects?: Array<ProjectEntry> | undefined;
};

function packageJson(json: JSONObject): string {
	return JSON.stringify(json);
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

/**
 * The script this run dispatched. A workspace run hands the backend a factory
 * rather than a script, so the whole run's script is the factory over every
 * job — what a lone bucket carries.
 *
 * @param captured - Holder of the backend options the stub captured.
 * @returns The script the factory builds over every job.
 */
function dispatchedScript(captured: Partial<Record<"options", BackendOptions>>): string {
	const options = captured.options!;
	return options.scriptFactory!(options.jobs);
}

function createStubBackend(
	entries: Array<BackendStubEntry>,
	backendOverrides: Partial<BackendResult> = {},
) {
	const captured: Partial<Record<"options", BackendOptions>> = {};
	const backend: Backend = {
		kind: "open-cloud",
		placeInput: "built",
		runTestsAsync: async (options): Promise<BackendResult> => {
			captured.options = options;
			return {
				...backendOverrides,
				rawResults: entries.map((entry) => {
					const envelope: EnvelopeEntry = { jestOutput: entry.jestOutput };
					if (entry.gameOutput !== undefined) {
						envelope.gameOutput = entry.gameOutput;
					}

					if (entry.pkg !== undefined) {
						envelope.pkg = entry.pkg;
					}

					if (entry.project !== undefined) {
						envelope.project = entry.project;
					}

					if (entry.snapshotWrites !== undefined) {
						envelope.snapshotWrites = entry.snapshotWrites;
					}

					return { entry: envelope };
				}),
				timing: { executionMs: 0, uploadMs: 0 },
			};
		},
	};
	return { backend, captured };
}

function makeRunOptions(overrides: Partial<WorkspaceRunOptions> = {}): WorkspaceRunOptions {
	return {
		backend: createResolvedConfig().backend,
		bail: false,
		color: createResolvedConfig().color,
		formatters: [],
		port: createResolvedConfig().port,
		silent: createResolvedConfig().silent,
		workspaceGameOutput: false,
		workspaceOutputFile: false,
		...overrides,
	};
}

function makeCli(overrides: Partial<CliOptions> = {}): CliOptions {
	return { ...overrides };
}

function timedRojo(fileSystem: FileSystem, onBuild: () => void): ChildProcessRunner {
	return fromAny({
		execFile: (
			...[, args, , callback]: [
				file: string,
				args: Array<string>,
				options: object,
				callback: (cause: Error | null, stdout: string, stderr: string) => void,
			]
		) => {
			onBuild();
			fileSystem.writeFileSync(String(args[3]), PLACE_BYTES);
			callback(null, "", "");
		},
	});
}

function stubRojo(fileSystem: FileSystem): ChildProcessRunner {
	return timedRojo(fileSystem, () => {});
}

function failingRojo(stderr: string): ChildProcessRunner {
	return fromAny({
		execFile: (
			...args: [
				file: string,
				args: Array<string>,
				options: object,
				callback: (cause: Error | null, stdout: string, stderr: string) => void,
			]
		) => {
			args[3](new Error("rojo exited with 1"), "", stderr);
		},
	});
}

function stagedPackages(fileSystem: FileSystem): Array<string> {
	const project = fromAny<{ tree: Record<string, Record<string, object>> }, JSONValue>(
		JSON.parse(fileSystem.readFileSync(SYNTHESIZED_PROJECT, "utf-8")),
	);
	const stage = project.tree["ServerStorage"]?.["__pkg_stage"] ?? {};
	return Object.keys(stage).filter((key) => !key.startsWith("$"));
}

function buildManifestPath(manifestPath: string): string {
	return path.join(path.dirname(manifestPath), "build-manifest.json");
}

function buildManifestAt(
	fileSystem: FileSystem,
	manifestPath: string,
): { coveragePlace: { path: string } } {
	return fromAny(JSON.parse(fileSystem.readFileSync(buildManifestPath(manifestPath), "utf-8")));
}

const loadPackageConfig = vi.fn<PackageConfigLoader>(async ({ cwd } = {}) => {
	return createResolvedConfig(cwd === undefined ? {} : { rootDir: cwd });
});

const runTypecheck = vi.fn<typeof runTypecheckAsync>();

type StagedRunOptions = Except<
	Parameters<typeof runWorkspaceAsync>[0],
	"cli" | "runOptions" | "version" | "workspaceRoot"
> &
	Partial<Parameters<typeof runWorkspaceAsync>[0]>;

async function runStagedWorkspaceAsync(
	options: StagedRunOptions,
): Promise<undefined | WorkspaceRunnerOutput> {
	const { fileSystem } = options;
	assert(fileSystem !== undefined);

	return runWorkspaceAsync({
		childProcess: stubRojo(fileSystem),
		cli: makeCli(),
		loadPackageConfig,
		runOptions: makeRunOptions(),
		runTypecheck,
		version: "0.0.0-test",
		workspaceRoot: ROOT,
		...options,
	});
}

/**
 * Most specs assert only on the runtime results array; unwrap it from the
 * runner output so they stay focused on the per-(package, project) entries.
 * Preserves the `undefined` preflight sentinel.
 *
 * @param options - Inputs passed through to the staged run.
 * @returns The runtime results, or `undefined` when preflight rejected the run.
 */
async function runWorkspaceResultsAsync(
	options: StagedRunOptions,
): Promise<Array<WorkspaceProjectResult> | undefined> {
	const output = await runStagedWorkspaceAsync(options);
	return output?.results;
}

function coverageEntry(packageName: string): WorkspacePackageCoverage {
	return {
		coverageRoots: [{ luauRoot: posixRoot("src"), shadowDir: "/shadow/src" }],
		coverageSpine: [],
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
		pkg: packageName,
		rootDir: FOO_DIR,
	};
}

function emptyJestConfig(directory: string) {
	return {
		[path.join(directory, "jest.config.ts")]: "export default {}",
	};
}

function makeProjectEntries(entries: Array<ProjectEntry>): Array<ProjectEntry> {
	return entries;
}

function setLoadedConfigPerPackage(map: Readonly<Record<string, PreResolutionConfig>>): void {
	loadPackageConfig.mockImplementation(async ({ cwd } = {}) => {
		const config = map[cwd ?? ""];
		if (config === undefined) {
			throw new Error(`No mocked config for cwd: ${cwd ?? "<undefined>"}`);
		}

		return fromAny<ResolvedConfig, PreResolutionConfig>(config);
	});
}

function seedPackage(
	directory: string,
	options: {
		extras?: Record<string, string>;
		name: string;
		specFiles?: Record<string, string>;
		tree?: JSONObject;
	},
) {
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

const WORKSPACE_YAML = {
	[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
};

interface Scenario {
	configs: Readonly<Record<string, PreResolutionConfig>>;
	entries: Array<BackendStubEntry>;
	files: Record<string, string>;
	run: Except<StagedRunOptions, "backend" | "fileSystem">;
}

function seedSpec(info: { name: string; packageDirectory: string }, ...specFiles: Array<string>) {
	return seedPackage(info.packageDirectory, {
		name: info.name,
		specFiles: Object.fromEntries(
			specFiles.map((specFile) => [path.join(info.packageDirectory, specFile), ""]),
		),
	});
}

function rooted(
	rootDirectory: string,
	overrides: Partial<PreResolutionConfig> = {},
): PreResolutionConfig {
	return { ...createResolvedConfig(), rootDir: rootDirectory, ...overrides };
}

function passingEntries(...packages: Array<string>): Array<BackendStubEntry> {
	return packages.map((name) => ({ jestOutput: passingResult(), pkg: name }));
}

function passingProjectEntry(name: string, project: string): BackendStubEntry {
	return { jestOutput: passingResult(), pkg: name, project };
}

function fooBarFiles(): Record<string, string> {
	return {
		...seedSpec(FOO_INFO, "src/foo.spec.luau"),
		...seedSpec(BAR_INFO, "src/bar.spec.luau"),
	};
}

function luauConfigs(...directories: Array<string>): Record<string, PreResolutionConfig> {
	return Object.fromEntries(
		directories.map((directory) => [
			directory,
			rooted(directory, { testMatch: ["**/*.spec.luau"] }),
		]),
	);
}

function clientServerFooFiles(): Record<string, string> {
	return seedPackage(FOO_DIR, {
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
	});
}

function customProjectBarFiles(): Record<string, string> {
	return {
		[path.join(BAR_DIR, "custom.project.json")]: packageJson({
			name: "bar-test",
			tree: { $className: "DataModel", ReplicatedStorage: { Pkg: { $path: "src" } } },
		}),
		[path.join(BAR_DIR, "jest.config.ts")]: "export default {}",
		[path.join(BAR_DIR, "package.json")]: packageJson({ name: "@halcyon/bar" }),
		[path.join(BAR_DIR, "src/bar.spec.luau")]: "",
	};
}

function stageWorkspace(
	files: Record<string, string>,
	configs: Readonly<Record<string, PreResolutionConfig>>,
): MemoryFileSystem {
	const memory = createMemoryFileSystem();
	memory.volume.fromJSON({ ...files, ...WORKSPACE_YAML });
	setLoadedConfigPerPackage(configs);
	return memory;
}

async function runScenarioAsync({ configs, entries, files, run }: Scenario) {
	const memory = stageWorkspace(files, configs);
	const stub = createStubBackend(entries);
	const output = await runStagedWorkspaceAsync({
		backend: stub.backend,
		fileSystem: memory.fileSystem,
		...run,
	});
	return { ...memory, ...stub, output, results: output?.results };
}

async function runLuauFooAsync(files: Record<string, string>, cli: CliOptions) {
	return runScenarioAsync({
		configs: { [FOO_DIR]: rooted(FOO_DIR, { testMatch: ["**/*.spec.luau"] }) },
		entries: [passingProjectEntry("@halcyon/foo", "@halcyon/foo")],
		files,
		run: { cli, packageInfos: [FOO_INFO] },
	});
}

const TIMEOUT_CONFIGS = {
	[BAR_DIR]: rooted(BAR_DIR, { testTimeout: 5678 }),
	[FOO_DIR]: rooted(FOO_DIR, { testTimeout: 1234 }),
};

const SETUP = ["./src/Shared/setup.luau"];

async function runSetupFooAsync(setup: Partial<PreResolutionConfig>) {
	return runScenarioAsync({
		configs: { [FOO_DIR]: rooted(FOO_DIR, setup) },
		entries: [passingProjectEntry("@halcyon/foo", "@halcyon/foo")],
		files: seedSpec(FOO_INFO, "src/foo.spec.luau", "src/Shared/setup.luau"),
		run: {
			createResolver: resolverReturning({
				[path.resolve(FOO_DIR, SETUP[0]!)]: ["ReplicatedStorage", "Pkg", "Shared", "setup"],
			}),
			packageInfos: [FOO_INFO],
		},
	});
}

async function runCoverageFooAsync(config: Partial<PreResolutionConfig> = {}) {
	const entry = coverageEntry("@halcyon/foo");
	const prepareCoverage = vi.fn<PrepareCoverage>(() => [entry]);
	const scenario = await runScenarioAsync({
		configs: { [FOO_DIR]: rooted(FOO_DIR, { collectCoverage: true, ...config }) },
		entries: passingEntries("@halcyon/foo"),
		files: seedSpec(FOO_INFO, "src/foo.spec.luau"),
		run: {
			cli: makeCli({ collectCoverage: true }),
			packageInfos: [FOO_INFO],
			prepareCoverage,
		},
	});
	return { ...scenario, entry, prepareCoverage };
}

function stagePassingTypecheckFoo(): MemoryFileSystem {
	const memory = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec-d.ts", "src/foo.spec.ts"), {
		[FOO_DIR]: rooted(FOO_DIR, { testMatch: ["**/*.spec.ts"], typecheck: { enabled: true } }),
	});
	runTypecheck.mockResolvedValue(
		makeTypeResult({
			testResults: [
				{
					numFailingTests: 0,
					numPassingTests: 1,
					numPendingTests: 0,
					testFilePath: "src/foo.spec-d.ts",
					testResults: [],
				},
			],
		}),
	);
	return memory;
}

async function typecheckFooFilesAsync(
	typecheck: NonNullable<PreResolutionConfig["typecheck"]>,
	...specFiles: Array<string>
): Promise<Array<string>> {
	runTypecheck.mockResolvedValue(makeTypeResult());
	await runScenarioAsync({
		configs: { [FOO_DIR]: rooted(FOO_DIR, { testMatch: ["**/*.spec.ts"], typecheck }) },
		entries: [passingProjectEntry("@halcyon/foo", "@halcyon/foo")],
		files: seedSpec(FOO_INFO, ...specFiles),
		run: { packageInfos: [FOO_INFO] },
	});
	return runTypecheck.mock.calls[0]![0].files;
}

describe("the place a workspace run uploads", () => {
	/**
	 * One passing package, run against the named backend.
	 * @param backendKind - The backend kind to run against.
	 * @returns The memory file system after the run.
	 */
	async function runOnBackendAsync(
		backendKind: Backend["kind"] = "open-cloud",
	): Promise<MemoryFileSystem> {
		const memory = createMemoryFileSystem();

		memory.volume.fromJSON({
			...seedSpec(FOO_INFO, "src/foo.spec.luau"),
			...WORKSPACE_YAML,
		});
		setLoadedConfigPerPackage({ [FOO_DIR]: rooted(FOO_DIR) });

		const { backend } = createStubBackend(passingEntries("@halcyon/foo"));

		await runStagedWorkspaceAsync({
			backend: { ...backend, kind: backendKind },
			fileSystem: memory.fileSystem,
			packageInfos: [FOO_INFO],
		});
		return memory;
	}

	/**
	 * A Shared Place run builds every package into the one place: only an
	 * Exclusive Place grant makes a Harness Place safe, and none exists.
	 */
	it("should build the whole open-cloud place", async () => {
		expect.assertions(2);

		const memory = await runOnBackendAsync();

		expect(memory.volume.existsSync(CODE_BUNDLE)).toBeFalse();
		expect(
			JSON.stringify(
				JSON.parse(memory.fileSystem.readFileSync(SYNTHESIZED_PROJECT, "utf-8")),
			),
		).toContain("Pkg");
	});

	it("should build the whole place for a Studio backend", async () => {
		expect.assertions(1);

		const memory = await runOnBackendAsync("studio");

		expect(memory.volume.existsSync(CODE_BUNDLE)).toBeFalse();
	});
});

describe(runWorkspaceAsync, () => {
	it("should load each package's config independently and embed both in the materializer payload", async () => {
		expect.assertions(2);

		const { captured } = await runScenarioAsync({
			configs: TIMEOUT_CONFIGS,
			entries: passingEntries("@halcyon/foo", "@halcyon/bar"),
			files: fooBarFiles(),
			run: {
				packageInfos: [FOO_INFO, BAR_INFO],
			},
		});

		expect(dispatchedScript(captured)).toContain('"testTimeout":1234');
		expect(dispatchedScript(captured)).toContain('"testTimeout":5678');
	});

	it("should hand the backend the VM count the run options carry", async () => {
		expect.assertions(1);

		const { captured } = await runScenarioAsync({
			configs: { [FOO_DIR]: rooted(FOO_DIR) },
			entries: passingEntries("@halcyon/foo"),
			files: seedSpec(FOO_INFO, "src/foo.spec.luau"),
			run: {
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ experimentalVmParallel: 3 }),
			},
		});

		expect(captured.options!.vmParallel).toBe(3);
	});

	// Workspace mode builds the materializer payload from the pending entries
	// rather than from the executor's jobs, so `printBasicPrototype` has to be
	// resolved before dispatch. Left unresolved, Jest-Roblox falls back to its
	// own default and a roblox-ts package's snapshots come back in `Table {`
	// form while multi mode writes `{`.
	it("should resolve printBasicPrototype for a typescript package before dispatch", async () => {
		expect.assertions(3);

		const { captured } = await runScenarioAsync({
			configs: { [FOO_DIR]: rooted(FOO_DIR) },
			entries: passingEntries("@halcyon/foo"),
			files: seedSpec(FOO_INFO, "src/foo.spec.ts"),
			run: {
				packageInfos: [FOO_INFO],
			},
		});

		expect(dispatchedScript(captured)).toContain('"printBasicPrototype":false');
		expect(dispatchedScript(captured)).not.toContain('"printBasicPrototype":true');
		expect(dispatchedScript(captured)).not.toContain('"testPathPattern":');
	});

	it("should resolve printBasicPrototype for a luau package before dispatch", async () => {
		expect.assertions(2);

		const { captured } = await runScenarioAsync({
			configs: { [BAR_DIR]: rooted(BAR_DIR) },
			entries: passingEntries("@halcyon/bar"),
			files: seedSpec(BAR_INFO, "src/bar.spec.luau"),
			run: {
				packageInfos: [BAR_INFO],
			},
		});

		expect(dispatchedScript(captured)).toContain('"printBasicPrototype":true');
		expect(dispatchedScript(captured)).not.toContain('"printBasicPrototype":false');
	});

	// The re-send path builds its script from the same entries, so the resolved
	// format has to survive a rebuild: a task that came back with work left over
	// must re-run it under the format its first attempt used.
	it("should keep the resolved printBasicPrototype in a rebuilt script", async () => {
		expect.assertions(1);

		const { captured } = await runScenarioAsync({
			configs: { [FOO_DIR]: rooted(FOO_DIR) },
			entries: passingEntries("@halcyon/foo"),
			files: seedSpec(FOO_INFO, "src/foo.spec.ts"),
			run: {
				packageInfos: [FOO_INFO],
			},
		});

		const factory = captured.options!.scriptFactory;
		assert(factory !== undefined);

		expect(factory(captured.options!.jobs)).toContain('"printBasicPrototype":false');
	});

	// A task that fills its return envelope comes back having run only some of
	// its entries. Without a queue to leave the rest in, the backend rebuilds a
	// script from what did not run — so the factory must select by (pkg,
	// project) rather than hand back the whole payload again.
	it("should supply a factory that rebuilds the script for a subset of jobs", async () => {
		expect.assertions(3);

		const { captured } = await runScenarioAsync({
			configs: TIMEOUT_CONFIGS,
			entries: passingEntries("@halcyon/foo", "@halcyon/bar"),
			files: fooBarFiles(),
			run: {
				packageInfos: [FOO_INFO, BAR_INFO],
			},
		});

		const factory = captured.options!.scriptFactory;
		assert(factory !== undefined);

		const barOnly = factory(
			captured.options!.jobs.filter((entry) => entry.pkg === "@halcyon/bar"),
		);

		expect(barOnly).toContain('"testTimeout":5678');
		expect(barOnly).not.toContain('"testTimeout":1234');
		expect(barOnly).not.toContain('"pkg":"@halcyon/foo"');
	});

	it("should forward a basename testPathPattern when --testPathPattern is a filesystem path", async () => {
		expect.assertions(2);

		const { captured } = await runLuauFooAsync(
			seedSpec(FOO_INFO, "src/foo.spec.luau"),
			makeCli({ testPathPattern: "src/foo.spec" }),
		);

		expect(dispatchedScript(captured)).toContain('"testPathPattern":"(Pkg/foo\\\\.spec)"');
		expect(dispatchedScript(captured)).not.toContain('"testPathPattern":"src/foo.spec"');
	});

	// Regression: two specs sharing a basename collapse to the same pattern, so
	// the namesake in `src/b` would run too. The pattern carries the path below
	// the package's Rojo mount instead.
	it("should forward the instance sub-path so a namesake spec is left out", async () => {
		expect.assertions(2);

		const { captured } = await runLuauFooAsync(
			seedSpec(FOO_INFO, "src/a/index.spec.luau", "src/b/index.spec.luau"),
			makeCli({ testPathPattern: "src/a/index.spec" }),
		);

		expect(dispatchedScript(captured)).toContain('"testPathPattern":"(Pkg/a/index\\\\.spec)"');
		expect(dispatchedScript(captured)).not.toContain('"testPathPattern":"(index\\\\.spec)"');
	});

	// Parity with multi: both modes narrow against `project.rojoMounts`, so an
	// `outDir`-pinned project resolves the file under its pinned mount rather
	// than under the widest mount the package's Rojo tree declares.
	it("should narrow against the project's pinned mount, not the package tree", async () => {
		expect.assertions(1);

		const projects = makeProjectEntries([
			{
				test: {
					displayName: "main",
					include: ["src/**/*.spec.luau"],
					outDir: "src/deep",
				},
			},
		]);
		const { captured } = await runScenarioAsync({
			configs: {
				[FOO_DIR]: rooted(FOO_DIR, { projects }),
			},
			entries: [passingProjectEntry("@halcyon/foo", "main")],
			files: {
				...seedSpec(FOO_INFO, "src/deep/thing.spec.luau"),
			},
			run: {
				cli: makeCli({ testPathPattern: "src/deep/thing.spec" }),
				packageInfos: [FOO_INFO],
			},
		});

		expect(dispatchedScript(captured)).toContain('"testPathPattern":"(deep/thing\\\\.spec)"');
	});

	it("should pass with no tests in a package the testPathPattern does not match", async () => {
		expect.assertions(2);

		const { captured } = await runLuauFooAsync(
			seedSpec(FOO_INFO, "src/foo.spec.luau"),
			makeCli({ testPathPattern: "src/other-package.spec" }),
		);

		expect(dispatchedScript(captured)).toContain('"passWithNoTests":true');
		// The zero-matching pattern is intentionally retained (not cleared) so
		// the Luau side runs nothing instead of falling back to testMatch.
		expect(dispatchedScript(captured)).toContain('"testPathPattern":"src/other-package.spec"');
	});

	// Regression: a positional file was discarded in workspace mode, so
	// `--workspace path/to/one.spec.ts` staged every package and ran the whole
	// workspace while reporting nothing about the argument it dropped.
	it("should dispatch only the package a positional file names", async () => {
		expect.assertions(3);

		const { captured, fileSystem } = await runScenarioAsync({
			configs: luauConfigs(BAR_DIR, FOO_DIR),
			entries: [passingProjectEntry("@halcyon/foo", "@halcyon/foo")],
			files: fooBarFiles(),
			run: {
				cli: makeCli({ files: [path.join(FOO_DIR, "src/foo.spec.luau")] }),
				packageInfos: [FOO_INFO, BAR_INFO],
			},
		});

		expect(captured.options!.jobs.map((job) => job.pkg)).toStrictEqual(["@halcyon/foo"]);

		// The place carries only the named package, so the build shrinks with
		// the selection rather than staging the whole workspace anyway.
		expect(stagedPackages(fileSystem)).toStrictEqual(["@halcyon/foo"]);
		expect(dispatchedScript(captured)).not.toContain("@halcyon/bar");
	});

	// A positional is typed relative to the directory the CLI was invoked from,
	// which is a package subdirectory as often as it is the workspace root. The
	// run takes that directory as an argument rather than reading it, so this
	// resolves a bare `src/foo.spec.luau` from inside `@halcyon/foo`.
	it("should resolve a relative positional against the invocation directory", async () => {
		expect.assertions(1);

		const { captured } = await runScenarioAsync({
			configs: luauConfigs(BAR_DIR, FOO_DIR),
			entries: [passingProjectEntry("@halcyon/foo", "@halcyon/foo")],
			files: fooBarFiles(),
			run: {
				cli: makeCli({ files: ["src/foo.spec.luau"] }),
				cwd: FOO_DIR,
				packageInfos: [FOO_INFO, BAR_INFO],
			},
		});

		expect(captured.options!.jobs.map((job) => job.pkg)).toStrictEqual(["@halcyon/foo"]);
	});

	// The Luau side matches Instance paths, so a positional narrows through the
	// same translation `--testPathPattern` does — a namesake in a sibling
	// directory must not ride along.
	it("should narrow to the positional file's instance sub-path", async () => {
		expect.assertions(2);

		const { captured } = await runLuauFooAsync(
			seedSpec(FOO_INFO, "src/a/index.spec.luau", "src/b/index.spec.luau"),
			makeCli({ files: [path.join(FOO_DIR, "src/a/index.spec.luau")] }),
		);

		expect(dispatchedScript(captured)).toContain('"testPathPattern":"(Pkg/a/index\\\\.spec)"');
		expect(dispatchedScript(captured)).not.toContain("b/index");
	});

	// A positional beats a `--testPathPattern` given alongside it, as in multi:
	// the file set is already resolved, so the raw pattern is dropped rather
	// than intersected.
	it("should let a positional file override a testPathPattern given with it", async () => {
		expect.assertions(2);

		const { captured } = await runLuauFooAsync(
			seedSpec(FOO_INFO, "src/a.spec.luau", "src/b.spec.luau"),
			makeCli({
				files: [path.join(FOO_DIR, "src/a.spec.luau")],
				testPathPattern: "src/b.spec",
			}),
		);

		expect(dispatchedScript(captured)).toContain('"testPathPattern":"(Pkg/a\\\\.spec)"');
		expect(dispatchedScript(captured)).not.toContain('"testPathPattern":"src/b.spec"');
	});

	// A file no package owns is a mistake in the argument, not an empty run:
	// reporting it as green would hide the typo behind a passing exit.
	it("should reject a positional file no package owns, naming the roots searched", async () => {
		expect.assertions(1);

		const { fileSystem } = stageWorkspace(
			seedSpec(FOO_INFO, "src/foo.spec.luau"),
			luauConfigs(FOO_DIR),
		);

		const { backend } = createStubBackend([]);

		await expect(
			runStagedWorkspaceAsync({
				backend,
				cli: makeCli({ files: [path.join(ROOT, "elsewhere/nope.spec.luau")] }),
				fileSystem,
				packageInfos: [FOO_INFO],
			}),
		).rejects.toThrow("No project contains the requested file(s):");
	});

	it("should synthesize one virtual project named after the package when projects: is absent", async () => {
		expect.assertions(2);

		const { captured, results } = await runScenarioAsync({
			configs: {
				[FOO_DIR]: rooted(FOO_DIR),
			},
			entries: [passingProjectEntry("@halcyon/foo", "@halcyon/foo")],
			files: seedSpec(FOO_INFO, "src/foo.spec.luau"),
			run: {
				packageInfos: [FOO_INFO],
			},
		});

		expect(dispatchedScript(captured)).toContain('"project":"@halcyon/foo"');
		expect(results![0]!.displayName).toBe("@halcyon/foo");
	});

	it("should open every host phase, nesting each package's config load", async () => {
		expect.assertions(2);

		const { fileSystem } = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
			[FOO_DIR]: rooted(FOO_DIR),
		});

		const { backend } = createStubBackend([
			passingProjectEntry("@halcyon/foo", "@halcyon/foo"),
		]);

		const { collector, paths } = recordingTimingCollector();
		await runStagedWorkspaceAsync({
			backend,
			fileSystem,
			packageInfos: [FOO_INFO],
			timing: collector,
		});

		expect(paths).toStrictEqual(
			expect.arrayContaining([
				"loadPackages",
				"loadPackages > load-config:@halcyon/foo",
				"resolveContexts",
				"discoverTests",
				"buildStubs",
				"buildJobs",
				"prepareDispatch",
				"runProjects",
			]),
		);
		expect(collector.flushTimingReport).not.toHaveBeenCalled();
	});

	it("should open the host phases before a later phase throws", async () => {
		expect.assertions(3);

		const { fileSystem } = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
			[FOO_DIR]: rooted(FOO_DIR),
		});

		const { backend } = createStubBackend([
			passingProjectEntry("@halcyon/foo", "@halcyon/foo"),
		]);

		const { collector, paths } = recordingTimingCollector();

		await expect(
			runStagedWorkspaceAsync({
				backend,
				childProcess: failingRojo("rojo boom"),
				fileSystem,
				packageInfos: [FOO_INFO],
				timing: collector,
			}),
		).rejects.toThrow("rojo boom");

		expect(paths).toContain("loadPackages");
		expect(paths).not.toContain("runProjects");
	});

	it("should pass through explicit projects when present, not virtual-wrap", async () => {
		expect.assertions(3);

		const projects = makeProjectEntries([
			{
				test: { displayName: "client", include: ["out/Client/**/*.spec.luau"] },
			},
			{
				test: { displayName: "server", include: ["out/Server/**/*.spec.luau"] },
			},
		]);
		const { captured, results } = await runScenarioAsync({
			configs: {
				[FOO_DIR]: rooted(FOO_DIR, { projects }),
			},
			entries: [
				passingProjectEntry("@halcyon/foo", "client"),
				passingProjectEntry("@halcyon/foo", "server"),
			],
			files: clientServerFooFiles(),
			run: {
				packageInfos: [FOO_INFO],
			},
		});

		expect(dispatchedScript(captured)).toContain('"project":"client"');
		expect(dispatchedScript(captured)).toContain('"project":"server"');
		expect(results!.map((entry) => entry.displayName)).toStrictEqual(["client", "server"]);
	});

	it("should drop runtime test files matching a per-project exclude glob", async () => {
		expect.assertions(1);

		const projects = makeProjectEntries([
			{
				test: {
					displayName: "main",
					exclude: ["**/*.gen.spec.luau"],
					include: ["src/**/*.spec.luau"],
				},
			},
		]);
		const { captured } = await runScenarioAsync({
			configs: {
				[FOO_DIR]: rooted(FOO_DIR, { projects }),
			},
			entries: [passingProjectEntry("@halcyon/foo", "main")],
			files: seedSpec(FOO_INFO, "src/a.gen.spec.luau", "src/a.spec.luau"),
			run: {
				packageInfos: [FOO_INFO],
			},
		});

		expect(captured.options!.jobs[0]!.testFiles).toStrictEqual(["src/a.spec.luau"]);
	});

	it("should drop runtime test files matching a package-level test.exclude glob", async () => {
		expect.assertions(1);

		// No `projects:` — the package's global `test.exclude` must flow into the
		// synthesized virtual project, mirroring single-mode `test.exclude`.
		const { captured } = await runScenarioAsync({
			configs: {
				[FOO_DIR]: rooted(FOO_DIR, {
					exclude: ["**/*.gen.spec.luau"],
				}),
			},
			entries: [passingProjectEntry("@halcyon/foo", "@halcyon/foo")],
			files: seedSpec(FOO_INFO, "src/a.gen.spec.luau", "src/a.spec.luau"),
			run: {
				packageInfos: [FOO_INFO],
			},
		});

		expect(captured.options!.jobs[0]!.testFiles).toStrictEqual(["src/a.spec.luau"]);
	});

	it("should pre-flight clean marker-bearing leftover stubs from package source and emit a stderr notice", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const leftoverStub = path.join(FOO_DIR, "out/Client/jest.config.luau");
		volume.fromJSON({
			...seedPackage(FOO_DIR, {
				name: "@halcyon/foo",
				specFiles: { [path.join(FOO_DIR, "out/Client/spec.spec.luau")]: "" },
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Client: { $path: "out/Client" } },
				},
			}),
			[leftoverStub]: "-- Auto-generated by jest-roblox (do not edit)\nreturn {}\n",
			...WORKSPACE_YAML,
		});

		const projects = makeProjectEntries([
			{
				test: { displayName: "client", include: ["out/Client/**/*.spec.luau"] },
			},
		]);
		setLoadedConfigPerPackage({
			[FOO_DIR]: rooted(FOO_DIR, { projects }),
		});

		const { backend } = createStubBackend([passingProjectEntry("@halcyon/foo", "client")]);

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		await runStagedWorkspaceAsync({
			backend,
			fileSystem,
			packageInfos: [FOO_INFO],
		});

		expect(volume.existsSync(leftoverStub)).toBeFalse();
		expect(stderr).toHaveBeenCalledWith(
			`jest-roblox: cleaned 1 leftover stub(s) from @halcyon/foo:\n  ${leftoverStub}\n`,
		);
	});

	it("should run a project jest.config.luau that holds code through the run's runner", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
			...seedPackage(FOO_DIR, {
				name: "@halcyon/foo",
				specFiles: { [path.join(FOO_DIR, "out/Client/spec.spec.luau")]: "" },
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Client: { $path: "out/Client" } },
				},
			}),
			[path.join(FOO_DIR, "out/Client/jest.config.luau")]:
				'return { displayName = "client" .. "-luau" }\n',
			[path.join(ROOT, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});
		setLoadedConfigPerPackage({
			[FOO_DIR]: rooted(FOO_DIR, { projects: ["out/Client"] }),
		});

		await expect(
			runStagedWorkspaceAsync({
				childProcess: createLuteChildProcess({ version: "9.9.9" }),
				cli: makeCli(),
				fileSystem,
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions(),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
			}),
		).rejects.toThrow('--version" printed "9.9.9"');
	});

	it("should write a cache stub for a mount that holds a user-authored config", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const userConfigPath = path.join(FOO_DIR, "out/Client/jest.config.luau");
		volume.fromJSON({
			...seedPackage(FOO_DIR, {
				name: "@halcyon/foo",
				specFiles: { [path.join(FOO_DIR, "out/Client/spec.spec.luau")]: "" },
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Client: { $path: "out/Client" } },
				},
			}),
			...WORKSPACE_YAML,
			[userConfigPath]: "return { displayName = 'user-shared' }\n",
		});

		const projects = makeProjectEntries([
			{
				test: { displayName: "client", include: ["out/Client/**/*.spec.luau"] },
			},
		]);
		setLoadedConfigPerPackage({
			[FOO_DIR]: rooted(FOO_DIR, { projects }),
		});

		const { backend } = createStubBackend([passingProjectEntry("@halcyon/foo", "client")]);

		await runStagedWorkspaceAsync({
			backend,
			fileSystem,
			packageInfos: [FOO_INFO],
		});

		expect(volume.readFileSync(userConfigPath, "utf8")).toBe(
			"return { displayName = 'user-shared' }\n",
		);

		const cacheStub = path.join(
			ROOT,
			".jest-roblox/workspace/@halcyon/foo/out/Client/jest.config.luau",
		);

		expect(volume.readFileSync(cacheStub, "utf8")).toStartWith(
			"-- Auto-generated by jest-roblox (do not edit)\n",
		);
	});

	it("should write stubs into the workspace cache, not into package source", async () => {
		expect.assertions(2);

		const projects = makeProjectEntries([
			{
				test: { displayName: "client", include: ["out/Client/**/*.spec.luau"] },
			},
		]);
		const { volume } = await runScenarioAsync({
			configs: {
				[FOO_DIR]: rooted(FOO_DIR, { projects }),
			},
			entries: [passingProjectEntry("@halcyon/foo", "client")],
			files: {
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: { [path.join(FOO_DIR, "out/Client/spec.spec.luau")]: "" },
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { Client: { $path: "out/Client" } },
					},
				}),
			},
			run: {
				packageInfos: [FOO_INFO],
			},
		});

		const cacheStub = path.join(
			ROOT,
			".jest-roblox/workspace/@halcyon/foo/out/Client/jest.config.luau",
		);
		const sourceStub = path.join(FOO_DIR, "out/Client/jest.config.luau");

		expect(volume.existsSync(cacheStub)).toBeTrue();
		expect(volume.existsSync(sourceStub)).toBeFalse();
	});

	it("should fan out (P × N) jobs, one per (package, project) pair", async () => {
		expect.assertions(2);

		const projects = makeProjectEntries([
			{
				test: { displayName: "client", include: ["out/Client/**/*.spec.luau"] },
			},
			{
				test: { displayName: "server", include: ["out/Server/**/*.spec.luau"] },
			},
		]);
		const { captured, results } = await runScenarioAsync({
			configs: {
				[BAR_DIR]: rooted(BAR_DIR, { projects }),
				[FOO_DIR]: rooted(FOO_DIR, { projects }),
			},
			entries: [
				passingProjectEntry("@halcyon/foo", "client"),
				passingProjectEntry("@halcyon/foo", "server"),
				passingProjectEntry("@halcyon/bar", "client"),
				passingProjectEntry("@halcyon/bar", "server"),
			],
			files: {
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
			},
			run: {
				packageInfos: [FOO_INFO, BAR_INFO],
			},
		});

		expect(captured.options!.jobs).toHaveLength(4);
		expect(results).toHaveLength(4);
	});

	it("should keep only filtered project displayNames when --project is set", async () => {
		expect.assertions(2);

		const projects = makeProjectEntries([
			{
				test: { displayName: "client", include: ["out/Client/**/*.spec.luau"] },
			},
			{
				test: { displayName: "server", include: ["out/Server/**/*.spec.luau"] },
			},
		]);
		const { results } = await runScenarioAsync({
			configs: {
				[FOO_DIR]: rooted(FOO_DIR, { projects }),
			},
			entries: [passingProjectEntry("@halcyon/foo", "client")],
			files: {
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
			},
			run: {
				cli: makeCli({ project: ["client"] }),
				packageInfos: [FOO_INFO],
			},
		});

		expect(results).toHaveLength(1);
		expect(results![0]!.displayName).toBe("client");
	});

	it("should throw when --project filter names match no project across packages", async () => {
		expect.assertions(1);

		const { fileSystem } = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
			[FOO_DIR]: rooted(FOO_DIR),
		});

		const { backend } = createStubBackend([]);

		await expect(
			runStagedWorkspaceAsync({
				backend,
				cli: makeCli({ project: ["nonexistent"] }),
				fileSystem,
				packageInfos: [FOO_INFO],
			}),
		).rejects.toThrow(/Unknown project name/);
	});

	it("should resolve per-project setupFiles and setupFilesAfterEnv against the package's rojo tree", async () => {
		expect.assertions(2);

		const { captured } = await runSetupFooAsync({
			setupFiles: SETUP,
			setupFilesAfterEnv: SETUP,
		});

		// The resolver replaces the filesystem string with the DataModel
		// path so the materializer payload carries the resolved setup
		// location, not the raw source path. Both setupFiles and
		// setupFilesAfterEnv are resolved.
		expect(dispatchedScript(captured)).toContain(
			'"setupFiles":["ReplicatedStorage/Pkg/Shared/setup"]',
		);
		expect(dispatchedScript(captured)).toContain(
			'"setupFilesAfterEnv":["ReplicatedStorage/Pkg/Shared/setup"]',
		);
	});

	it("should not build a rojo resolver for packages without setup files", async () => {
		expect.assertions(1);

		const { fileSystem } = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
			[FOO_DIR]: rooted(FOO_DIR),
		});

		const createResolver = vi.fn<RojoResolverFactory>();

		const { backend } = createStubBackend([
			passingProjectEntry("@halcyon/foo", "@halcyon/foo"),
		]);

		await runStagedWorkspaceAsync({
			backend,
			createResolver,
			fileSystem,
			packageInfos: [FOO_INFO],
		});

		// No project declares setupFiles/setupFilesAfterEnv, so the costly
		// RojoResolver tree walk must be skipped entirely — it is the dominant
		// resolveContexts cost and resolves nothing here.
		expect(createResolver).not.toHaveBeenCalled();
	});

	it("should resolve a project that declares only setupFiles", async () => {
		expect.assertions(2);

		const { captured } = await runSetupFooAsync({ setupFiles: SETUP });

		expect(dispatchedScript(captured)).toContain(
			'"setupFiles":["ReplicatedStorage/Pkg/Shared/setup"]',
		);
		expect(dispatchedScript(captured)).not.toContain('"setupFilesAfterEnv"');
	});

	it("should resolve a project that declares only setupFilesAfterEnv", async () => {
		expect.assertions(2);

		const { captured } = await runSetupFooAsync({ setupFilesAfterEnv: SETUP });

		expect(dispatchedScript(captured)).toContain(
			'"setupFilesAfterEnv":["ReplicatedStorage/Pkg/Shared/setup"]',
		);
		expect(dispatchedScript(captured)).not.toContain('"setupFiles":');
	});

	it("should honor per-package rojoProject from each package's own jest.config", async () => {
		expect.assertions(2);

		const { fileSystem } = stageWorkspace(
			{
				// Bar has ONLY custom.project.json — no test.project.json on
				// disk. Bar's per-package config sets rojoProject:
				// "custom.project.json". If the per-package value is ignored,
				// preflight fails because the default test.project.json does not
				// exist at Bar.
				...customProjectBarFiles(),
				[path.join(FOO_DIR, "jest.config.ts")]: "export default {}",
				[path.join(FOO_DIR, "package.json")]: packageJson({
					name: "@halcyon/foo",
				}),
				[path.join(FOO_DIR, "src/foo.spec.luau")]: "",
				// Foo has only test.project.json (default).
				[path.join(FOO_DIR, "test.project.json")]: packageJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { Pkg: { $path: "src" } },
					},
				}),
			},
			{
				[BAR_DIR]: rooted(BAR_DIR, {
					rojoProject: "custom.project.json",
				}),
				[FOO_DIR]: rooted(FOO_DIR),
			},
		);

		const { backend, captured } = createStubBackend([
			passingProjectEntry("@halcyon/foo", "@halcyon/foo"),
			passingProjectEntry("@halcyon/bar", "@halcyon/bar"),
		]);

		const results = await runWorkspaceResultsAsync({
			backend,
			fileSystem,
			packageInfos: [FOO_INFO, BAR_INFO],
		});

		// Both packages produce jobs because each package's own rojoProject
		// resolves correctly. Without the fix, Bar's preflight fails on the
		// non-existent test.project.json (the parent default).
		expect(captured.options!.jobs).toHaveLength(2);
		expect(results!.map((entry) => entry.pkg)).toStrictEqual(["@halcyon/foo", "@halcyon/bar"]);
	});

	it("should resolve a Nevermore-style subdir rojoProject that mounts the package via '..'", async () => {
		expect.assertions(2);

		const projects = makeProjectEntries([
			{ test: { displayName: "@halcyon/foo", include: ["src/**/*.spec.lua"] } },
		]);
		const { captured, results } = await runScenarioAsync({
			configs: {
				[FOO_DIR]: rooted(FOO_DIR, {
					projects,
					rojoProject: "test/default.project.json",
				}),
			},
			entries: [passingProjectEntry("@halcyon/foo", "@halcyon/foo")],
			files: {
				// Package manifest maps src to the tree root (standard Wally
				// layout).
				[path.join(FOO_DIR, "default.project.json")]: packageJson({
					name: "foo",
					tree: { $path: "src" },
				}),
				[path.join(FOO_DIR, "jest.config.ts")]: "export default {}",
				[path.join(FOO_DIR, "package.json")]: packageJson({
					name: "@halcyon/foo",
				}),
				[path.join(FOO_DIR, "src/foo.spec.lua")]: "",
				// Test harness lives in a subdirectory and mounts the package via
				// "..", which Rojo resolves through the package
				// default.project.json.
				[path.join(FOO_DIR, "test/default.project.json")]: packageJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ServerScriptService: { Pkg: { $path: ".." } },
					},
				}),
			},
			run: {
				packageInfos: [FOO_INFO],
			},
		});

		// The "src" include root (package-relative) resolves through the
		// package's default.project.json into the ServerScriptService/Pkg mount
		// declared by the subdirectory test project.
		expect(dispatchedScript(captured)).toContain('"projects":["ServerScriptService/Pkg"]');
		expect(results![0]!.displayName).toBe("@halcyon/foo");
	});

	// Workspace-root `config.rojoProject` no longer falls back into
	// per-package descriptor resolution. Each package must declare its own
	// rojoProject (directly or via extends); the workspace-root config
	// silently dropping a custom value into per-pkg lookups was the same
	// "workspace-root vs per-pkg" leak as the other A2 sites.
	it("should NOT fall back to workspace-root config.rojoProject when the package config omits it", async () => {
		expect.assertions(1);

		// Bar's per-pkg config has no rojoProject — previously the middle
		// arm of `pkg ?? config ?? DEFAULT` would pick up the workspace-root
		// value below and resolve "custom.project.json". After the collapse,
		// resolution falls straight to `ROJO_PROJECT_DEFAULT`
		// ("test.project.json") — which does not exist at BAR_DIR, so preflight
		// fails.
		const { fileSystem } = stageWorkspace(
			{
				...customProjectBarFiles(),
			},
			{
				[BAR_DIR]: rooted(BAR_DIR),
			},
		);

		const { backend } = createStubBackend([]);

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const results = await runWorkspaceResultsAsync({
			backend,
			fileSystem,
			packageInfos: [BAR_INFO],
		});

		stderr.mockRestore();

		expect(results).toBeUndefined();
	});

	it("should drop empty packages from the materializer payload while keeping packages with specs", async () => {
		expect.assertions(2);

		const { captured, results } = await runScenarioAsync({
			configs: {
				[BAR_DIR]: rooted(BAR_DIR, {
					passWithNoTests: true,
				}),
				[FOO_DIR]: rooted(FOO_DIR),
			},
			entries: [passingProjectEntry("@halcyon/foo", "@halcyon/foo")],
			files: {
				...seedSpec(FOO_INFO, "src/a.spec.luau", "src/b.spec.luau"),
				...seedPackage(BAR_DIR, { name: "@halcyon/bar" }),
			},
			run: {
				packageInfos: [FOO_INFO, BAR_INFO],
			},
		});

		// The empty bar package must NOT produce a job; only foo's job is
		// enqueued because foo is the only package with discovered specs.
		expect(captured.options!.jobs).toHaveLength(1);
		expect(results!.map((entry) => entry.pkg)).toStrictEqual(["@halcyon/foo"]);
	});

	it("should pass with no tests when passWithNoTests is true and zero specs are discovered", async () => {
		expect.assertions(2);

		const { fileSystem } = stageWorkspace(
			{ ...seedPackage(FOO_DIR, { name: "@halcyon/foo" }) },
			{
				[FOO_DIR]: rooted(FOO_DIR, {
					passWithNoTests: true,
				}),
			},
		);

		const { backend } = createStubBackend([]);
		const mkdir = vi.spyOn(fileSystem, "mkdirSync");

		const results = await runWorkspaceResultsAsync({
			backend,
			fileSystem,
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions({ workspaceOutputFile: true }),
		});

		expect(results).toStrictEqual([]);
		expect(mkdir).not.toHaveBeenCalledWith(
			path.join(ROOT, ".jest-roblox", "output"),
			expect.anything(),
		);
	});

	it("should honor per-package passWithNoTests when the workspace config does not set it", async () => {
		expect.assertions(1);

		// Package opts in to passWithNoTests via its OWN jest.config; the
		// workspace-level config has no real global. Workspace mode must
		// consult the per-package value, not aggregate over the workspace
		// root.
		const { results } = await runScenarioAsync({
			configs: {
				[FOO_DIR]: rooted(FOO_DIR, {
					passWithNoTests: true,
				}),
			},
			entries: [],
			files: {
				...seedPackage(FOO_DIR, { name: "@halcyon/foo" }),
			},
			run: {
				packageInfos: [FOO_INFO],
			},
		});

		expect(results).toStrictEqual([]);
	});

	it("should error when one package has zero tests and its own passWithNoTests is false even if another package opts in", async () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		volume.fromJSON({
			...seedPackage(FOO_DIR, { name: "@halcyon/foo" }),
			...seedPackage(BAR_DIR, { name: "@halcyon/bar" }),
			...WORKSPACE_YAML,
		});

		setLoadedConfigPerPackage({
			[BAR_DIR]: rooted(BAR_DIR),
			[FOO_DIR]: rooted(FOO_DIR, {
				passWithNoTests: true,
			}),
		});

		const { backend } = createStubBackend([]);

		const results = await runWorkspaceResultsAsync({
			backend,
			fileSystem,
			packageInfos: [FOO_INFO, BAR_INFO],
		});

		expect(results).toBeUndefined();
		expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/@halcyon\/bar/));
		expect(stderr).not.toHaveBeenCalledWith(expect.stringMatching(/@halcyon\/foo/));
	});

	it("should map each backend result to a WorkspaceProjectResult preserving pkg + project axes", async () => {
		expect.assertions(4);

		const { results } = await runScenarioAsync({
			configs: {
				[BAR_DIR]: rooted(BAR_DIR),
				[BAZ_DIR]: rooted(BAZ_DIR),
				[FOO_DIR]: rooted(FOO_DIR),
			},
			entries: [
				passingProjectEntry("@halcyon/foo", "@halcyon/foo"),
				{
					jestOutput: failingResult(),
					pkg: "@halcyon/bar",
					project: "@halcyon/bar",
				},
				passingProjectEntry("@halcyon/baz", "@halcyon/baz"),
			],
			files: {
				...seedSpec(FOO_INFO, "src/foo.spec.luau"),
				...seedSpec(BAR_INFO, "src/bar.spec.luau"),
				...seedSpec(BAZ_INFO, "src/baz.spec.luau"),
			},
			run: {
				packageInfos: [FOO_INFO, BAR_INFO, BAZ_INFO],
			},
		});

		expect(results!.map((entry) => entry.pkg)).toStrictEqual([
			"@halcyon/foo",
			"@halcyon/bar",
			"@halcyon/baz",
		]);
		expect(results![0]!.displayName).toBe("@halcyon/foo");
		expect(results![1]!.result.exitCode).toBe(1);
		expect(results![2]!.result.exitCode).toBe(0);
	});

	it("should auto-create $path directories that have child entries even with extension", async () => {
		expect.assertions(2);

		const projects = makeProjectEntries([
			{
				test: { displayName: "main", include: ["src/has.dot/**/*.spec.luau"] },
			},
		]);
		const { volume } = await runScenarioAsync({
			configs: {
				[FOO_DIR]: rooted(FOO_DIR, { projects }),
			},
			entries: [],
			files: {
				[path.join(FOO_DIR, "package.json")]: packageJson({
					name: "@halcyon/foo",
				}),
				// Pre-existing leaf-file mount lets ensure-paths see a $path with
				// extension and no children — should NOT be created as a
				// directory.
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
			},
			run: {
				packageInfos: [FOO_INFO],
			},
		});

		expect(volume.existsSync(path.join(FOO_DIR, "src/has.dot"))).toBeTrue();
		// init.luau wasn't directory-created (would clobber the existing file).
		expect(volume.statSync(path.join(FOO_DIR, "src/init.luau")).isFile()).toBeTrue();
	});

	it("should include dotted-name directories as virtual-wrap mounts", async () => {
		expect.assertions(1);

		const { captured } = await runScenarioAsync({
			configs: {
				[FOO_DIR]: rooted(FOO_DIR),
			},
			entries: [passingProjectEntry("@halcyon/foo", "@halcyon/foo")],
			files: {
				[path.join(FOO_DIR, "package.json")]: packageJson({
					name: "@halcyon/foo",
				}),
				[path.join(FOO_DIR, "src/has.dot/spec.spec.luau")]: "",
				[path.join(FOO_DIR, "test.project.json")]: packageJson({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { Container: { $path: "src/has.dot" } },
					},
				}),
				...emptyJestConfig(FOO_DIR),
			},
			run: {
				packageInfos: [FOO_INFO],
			},
		});

		// The virtual-wrap project must include the dotted-name directory
		// mount; without the fix the directory is mis-classified as a file
		// and produces zero jobs.
		expect(captured.options!.jobs).toHaveLength(1);
	});

	describe("coverage", () => {
		it("should call prepareWorkspaceCoverage with the workspace packages when collectCoverage is set", async () => {
			expect.assertions(1);

			const { prepareCoverage } = await runCoverageFooAsync();

			expect(prepareCoverage).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					packages: [expect.objectContaining({ name: "@halcyon/foo" })],
				}),
			);
		});

		// The per-package coverage knobs must reach the descriptor so
		// `prepareWorkspaceCoverage`'s discovery and ignore-matcher both see the
		// merged pkgConfig values. Pre-fix `loadPackages` only populated
		// `name`/`packageDirectory`/`rojoProjectPath` and silently dropped
		// `luauRoots` + `coveragePathIgnorePatterns`.
		it("should propagate pkgConfig luauRoots and coveragePathIgnorePatterns onto the descriptor", async () => {
			expect.assertions(2);

			const { prepareCoverage } = await runCoverageFooAsync({
				coveragePathIgnorePatterns: ["**/vendored-packages/**"],
				luauRoots: ["src"],
			});

			const callArgs = prepareCoverage.mock.calls[0]![0];
			const descriptor = callArgs.packages[0]!;

			expect(descriptor.luauRoots).toStrictEqual(["src"]);
			expect(descriptor.coveragePathIgnorePatterns).toStrictEqual([
				"**/vendored-packages/**",
			]);
		});

		it("should propagate pkgConfig.coverageCache: false onto the descriptor", async () => {
			expect.assertions(1);

			const { prepareCoverage } = await runCoverageFooAsync({
				coverageCache: false,
			});

			const callArgs = prepareCoverage.mock.calls[0]![0];
			const descriptor = callArgs.packages[0]!;

			expect(descriptor.coverageCache).toBeFalse();
		});

		it("should embed runnerCoverage in the materializer config when collectCoverage is set", async () => {
			expect.assertions(1);

			const { fileSystem } = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
				[FOO_DIR]: rooted(FOO_DIR, {
					collectCoverage: true,
				}),
			});

			const prepareCoverage = vi.fn<PrepareCoverage>(() => [
				{
					coverageRoots: [],
					coverageSpine: [],
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
					rootDir: FOO_DIR,
				},
			]);

			const { backend, captured } = createStubBackend(passingEntries("@halcyon/foo"));

			await runStagedWorkspaceAsync({
				backend,
				cli: makeCli({ collectCoverage: true }),
				fileSystem,
				packageInfos: [FOO_INFO],
				prepareCoverage,
			});

			expect(dispatchedScript(captured)).toContain('"runnerCoverage":true');
		});

		it("should expose per-package coverage descriptors on the workspace result", async () => {
			expect.assertions(2);

			const { fileSystem } = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
				[FOO_DIR]: rooted(FOO_DIR, {
					collectCoverage: true,
				}),
			});

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
			const prepareCoverage = vi.fn<PrepareCoverage>(() => [
				{
					coverageRoots: [{ luauRoot: posixRoot("src"), shadowDir: "/shadow/src" }],
					coverageSpine: [],
					manifest,
					manifestPath: "/shadow/coverage-manifest.json",
					pkg: "@halcyon/foo",
					rootDir: FOO_DIR,
				},
			]);

			const { backend } = createStubBackend(passingEntries("@halcyon/foo"));

			const results = await runWorkspaceResultsAsync({
				backend,
				cli: makeCli({ collectCoverage: true }),
				fileSystem,
				packageInfos: [FOO_INFO],
				prepareCoverage,
			});

			expect(results![0]!.coverageManifest).toBe(manifest);
			expect(results![0]!.pkg).toBe("@halcyon/foo");
		});

		it("should carry the package's own coverage report settings onto the workspace result", async () => {
			expect.assertions(1);

			const { fileSystem } = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
				[FOO_DIR]: rooted(FOO_DIR, {
					collectCoverage: true,
					collectCoverageFrom: ["src/**/*.ts"],
					coverageDirectory: "reports/cov",
					coverageReporters: ["cobertura"],
					coverageThreshold: { branches: 70, statements: 90 },
				}),
			});

			const prepareCoverage = vi.fn<PrepareCoverage>(() => [
				{
					...coverageEntry("@halcyon/foo"),
					coveragePathIgnorePatterns: ["**/vendor/**"],
				},
			]);

			const { backend } = createStubBackend(passingEntries("@halcyon/foo"));

			const results = await runWorkspaceResultsAsync({
				backend,
				cli: makeCli({ collectCoverage: true }),
				fileSystem,
				packageInfos: [FOO_INFO],
				prepareCoverage,
			});

			// `coverageDirectory` resolves against the package's own rootDir, so
			// the report lands beside the package rather than at the directory
			// the CLI happened to run from.
			expect(results![0]!.coverageSettings).toStrictEqual({
				collectCoverageFrom: ["src/**/*.ts"],
				coverageDirectory: path.resolve(FOO_DIR, "reports/cov"),
				coveragePathIgnorePatterns: ["**/vendor/**"],
				coverageReporters: ["cobertura"],
				coverageThreshold: { branches: 70, statements: 90 },
				rootDir: FOO_DIR,
			});
		});

		it("should warn when a package declares coverageThreshold without collectCoverage", async () => {
			expect.assertions(2);

			// foo's threshold can never be enforced (no instrumentation without
			// collectCoverage); bar opted in properly and must not be flagged.
			const { fileSystem } = stageWorkspace(fooBarFiles(), {
				[BAR_DIR]: rooted(BAR_DIR, {
					collectCoverage: true,
					coverageThreshold: { lines: 100 },
				}),
				[FOO_DIR]: rooted(FOO_DIR, {
					coverageThreshold: { statements: 90 },
				}),
			});

			const prepareCoverage = vi.fn<PrepareCoverage>(() => [coverageEntry("@halcyon/bar")]);

			const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

			const { backend } = createStubBackend(passingEntries("@halcyon/foo", "@halcyon/bar"));

			await runStagedWorkspaceAsync({
				backend,
				fileSystem,
				packageInfos: [FOO_INFO, BAR_INFO],
				prepareCoverage,
			});

			const warnings = stderr.mock.calls
				.map(([chunk]) => String(chunk))
				.filter((line) => line.includes("coverageThreshold"));

			expect(warnings).toStrictEqual([
				"jest-roblox: @halcyon/foo declares coverageThreshold but not collectCoverage; the threshold is not enforced\n",
			]);
			expect(warnings[0]).not.toContain("@halcyon/bar");
		});

		it("should restrict prepareWorkspaceCoverage to packages with pending test files", async () => {
			expect.assertions(1);

			const { fileSystem } = stageWorkspace(
				{
					// foo has a spec file
					...seedSpec(FOO_INFO, "src/foo.spec.luau"),
					// bar has NO spec files — should be excluded from
					// instrumentation
					...seedPackage(BAR_DIR, {
						name: "@halcyon/bar",
						specFiles: {},
					}),
				},
				{
					[BAR_DIR]: rooted(BAR_DIR, {
						collectCoverage: true,
						passWithNoTests: true,
					}),
					[FOO_DIR]: rooted(FOO_DIR, {
						collectCoverage: true,
					}),
				},
			);

			const prepareCoverage = vi.fn<PrepareCoverage>(() => []);

			const { backend } = createStubBackend(passingEntries("@halcyon/foo"));

			await runStagedWorkspaceAsync({
				backend,
				cli: makeCli({ collectCoverage: true }),
				fileSystem,
				packageInfos: [FOO_INFO, BAR_INFO],
				prepareCoverage,
			});

			const callArgs = prepareCoverage.mock.calls[0]![0];

			expect(callArgs.packages.map((entry) => entry.name)).toStrictEqual(["@halcyon/foo"]);
		});

		it("should not call prepareWorkspaceCoverage when collectCoverage is false", async () => {
			expect.assertions(1);

			const { fileSystem } = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
				[FOO_DIR]: rooted(FOO_DIR),
			});

			const prepareCoverage = vi.fn<PrepareCoverage>(() => []);
			const { backend } = createStubBackend(passingEntries("@halcyon/foo"));

			await runStagedWorkspaceAsync({
				backend,
				fileSystem,
				packageInfos: [FOO_INFO],
				prepareCoverage,
			});

			expect(prepareCoverage).not.toHaveBeenCalled();
		});

		it("should honor per-package collectCoverage when the workspace config does not set it", async () => {
			expect.assertions(1);

			// Per-package opts in; workspace does not. The workspace runner
			// must still instrument so the materializer's runtime coverage
			// collection has a shadow dir to read from.
			const { fileSystem } = stageWorkspace(
				{
					...seedSpec(FOO_INFO, "src/foo.spec.luau"),
				},
				{
					[FOO_DIR]: rooted(FOO_DIR, {
						collectCoverage: true,
					}),
				},
			);

			const prepareCoverage = vi.fn<PrepareCoverage>(() => []);

			const { backend } = createStubBackend(passingEntries("@halcyon/foo"));

			await runStagedWorkspaceAsync({
				backend,
				fileSystem,
				packageInfos: [FOO_INFO],
				prepareCoverage,
			});

			const callArgs = prepareCoverage.mock.calls[0]![0];

			expect(callArgs.packages.map((entry) => entry.name)).toStrictEqual(["@halcyon/foo"]);
		});

		it("should restrict prepareWorkspaceCoverage to packages that opted in via per-package collectCoverage", async () => {
			expect.assertions(1);

			const { fileSystem } = stageWorkspace(fooBarFiles(), {
				[BAR_DIR]: rooted(BAR_DIR),
				[FOO_DIR]: rooted(FOO_DIR, {
					collectCoverage: true,
				}),
			});

			const prepareCoverage = vi.fn<PrepareCoverage>(() => []);

			const { backend } = createStubBackend(passingEntries("@halcyon/foo", "@halcyon/bar"));

			await runStagedWorkspaceAsync({
				backend,
				fileSystem,
				packageInfos: [FOO_INFO, BAR_INFO],
				prepareCoverage,
			});

			const callArgs = prepareCoverage.mock.calls[0]![0];

			expect(callArgs.packages.map((entry) => entry.name)).toStrictEqual(["@halcyon/foo"]);
		});

		it("should emit per-package build manifests over the built place after a coverage run", async () => {
			expect.assertions(1);

			const { entry, fileSystem } = await runCoverageFooAsync();

			expect(buildManifestAt(fileSystem, entry.manifestPath).coveragePlace.path).toBe(
				path.join(WORKSPACE_CACHE, "synthesized.rbxl"),
			);
		});

		it("should not emit a build manifest when the shared place build fails", async () => {
			expect.assertions(2);

			const { fileSystem } = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
				[FOO_DIR]: rooted(FOO_DIR, {
					collectCoverage: true,
				}),
			});

			const entry = coverageEntry("@halcyon/foo");
			const prepareCoverage = vi.fn<PrepareCoverage>(() => [entry]);

			const { backend } = createStubBackend(passingEntries("@halcyon/foo"));

			await expect(
				runStagedWorkspaceAsync({
					backend,
					childProcess: failingRojo("rojo boom"),
					cli: makeCli({ collectCoverage: true }),
					fileSystem,
					packageInfos: [FOO_INFO],
					prepareCoverage,
				}),
			).rejects.toThrow("rojo boom");

			expect(fileSystem.existsSync(buildManifestPath(entry.manifestPath))).toBeFalse();
		});

		it("should not emit a build manifest when coverage is disabled", async () => {
			expect.assertions(1);

			const { fileSystem } = await runScenarioAsync({
				configs: {
					[FOO_DIR]: rooted(FOO_DIR),
				},
				entries: passingEntries("@halcyon/foo"),
				files: seedSpec(FOO_INFO, "src/foo.spec.luau"),
				run: {
					packageInfos: [FOO_INFO],
				},
			});

			expect(
				fileSystem.existsSync(
					buildManifestPath(coverageEntry("@halcyon/foo").manifestPath),
				),
			).toBeFalse();
		});
	});

	it("should measure the place staging as stagingMs", async () => {
		expect.assertions(3);

		const { fileSystem } = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
			[FOO_DIR]: rooted(FOO_DIR),
		});

		// Staging is synchronous, so the only way to give it a measurable
		// duration is to move the clock from inside the rojo build it ends on.
		// Two counters, moved by different amounts: a phase duration comes off
		// the collector's clock, while `startTime` stamps the wall clock the
		// "Start at" line renders.
		const clock = movableClockCollector(0);
		let wallMs = 1_000;
		vi.spyOn(Date, "now").mockImplementation(() => wallMs);

		const { backend } = createStubBackend(passingEntries("@halcyon/foo"));

		const output = await runStagedWorkspaceAsync({
			backend,
			childProcess: timedRojo(fileSystem, () => {
				clock.advance(250);
				wallMs += 900;
			}),
			fileSystem,
			packageInfos: [FOO_INFO],
			timing: clock.timing,
		});

		expect(output!.stagingMs).toBe(250);
		// No package collected coverage, so nothing is reported under it.
		expect(output!.coverageMs).toBe(0);
		// The dispatch window must start after staging, or the reported total
		// would count the build twice.
		expect(output!.results[0]!.result.timing.startTime).toBe(1_900);
	});

	it("should report the coverage bake apart from the staging around it", async () => {
		expect.assertions(2);

		const { fileSystem } = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
			[FOO_DIR]: rooted(FOO_DIR, {
				collectCoverage: true,
			}),
		});

		const clock = movableClockCollector(1_000);

		const { backend } = createStubBackend(passingEntries("@halcyon/foo"));

		const output = await runStagedWorkspaceAsync({
			backend,
			childProcess: timedRojo(fileSystem, () => {
				clock.advance(250);
			}),
			cli: makeCli({ collectCoverage: true }),
			fileSystem,
			packageInfos: [FOO_INFO],
			prepareCoverage: vi.fn<PrepareCoverage>(() => {
				clock.advance(120);
				return [coverageEntry("@halcyon/foo")];
			}),
			timing: clock.timing,
		});

		expect(output!.coverageMs).toBe(120);
		expect(output!.stagingMs).toBe(250);
	});

	describe("work-stealing", () => {
		const testCredentials = { apiKey: "test-key", universeId: "u-123" };
		const prepareWorkStealingQueue = vi.fn<typeof prepareWorkStealingQueueAsync>();

		async function runStealingWorkspaceAsync(
			options: Parameters<typeof runWorkspaceAsync>[0],
		): Promise<undefined | WorkspaceRunnerOutput> {
			return runStagedWorkspaceAsync({ prepareWorkStealingQueue, ...options });
		}

		async function runStealingFooAsync(
			run: Partial<StagedRunOptions>,
			specFile = "src/foo.spec.luau",
		) {
			return runScenarioAsync({
				configs: { [FOO_DIR]: rooted(FOO_DIR) },
				entries: passingEntries("@halcyon/foo"),
				files: seedSpec(FOO_INFO, specFile),
				run: { packageInfos: [FOO_INFO], prepareWorkStealingQueue, ...run },
			});
		}

		function mockPreparedQueue(queueId: string): void {
			prepareWorkStealingQueue.mockResolvedValue({
				invisibilityWindowSeconds: 90,
				queueId,
				ttlSeconds: 600,
			});
		}

		it("should push every (pkg, project) onto the queue and pass workStealing to backend when parallel>1", async () => {
			expect.assertions(3);

			const { fileSystem } = stageWorkspace(fooBarFiles(), {
				[BAR_DIR]: rooted(BAR_DIR),
				[FOO_DIR]: rooted(FOO_DIR),
			});

			mockPreparedQueue("queue-1");
			const { backend, captured } = createStubBackend(
				passingEntries("@halcyon/foo", "@halcyon/bar"),
			);

			await runStealingWorkspaceAsync({
				backend,
				cli: makeCli(),
				fileSystem,
				packageInfos: [FOO_INFO, BAR_INFO],
				runOptions: makeRunOptions({ parallel: 2 }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
				workStealingCredentials: testCredentials,
			});

			expect(captured.options!.workStealing).toBeTrue();
			expect(captured.options!.parallel).toBe(2);

			const prepareCall = prepareWorkStealingQueue.mock.calls[0]![0];

			expect(prepareCall.packages).toIncludeAllMembers([
				{ pkg: "@halcyon/foo", project: "@halcyon/foo" },
				{ pkg: "@halcyon/bar", project: "@halcyon/bar" },
			]);
		});

		it("should embed the same queueId in the script as the queue pushes", async () => {
			expect.assertions(1);

			mockPreparedQueue("specific-queue-id");
			const { captured } = await runStealingFooAsync({
				runOptions: makeRunOptions({ parallel: 2 }),
				workStealingCredentials: testCredentials,
			});

			expect(captured.options!.scriptOverride).toContain('"queueId":"specific-queue-id"');
		});

		// The queue script is generated from the same entries as the ordinary
		// one, so a package's format must not depend on which of the two paths
		// the run took.
		it("should carry the resolved printBasicPrototype into the queue script", async () => {
			expect.assertions(1);

			mockPreparedQueue("queue-format");
			const { captured } = await runStealingFooAsync(
				{
					runOptions: makeRunOptions({ parallel: 2 }),
					workStealingCredentials: testCredentials,
				},
				"src/foo.spec.ts",
			);

			expect(captured.options!.scriptOverride).toContain('"printBasicPrototype":false');
		});

		it("should shard on parallel auto rather than falling back to one task", async () => {
			expect.assertions(2);

			mockPreparedQueue("queue-auto");
			const { captured } = await runStealingFooAsync({
				runOptions: makeRunOptions({ parallel: "auto" }),
				workStealingCredentials: testCredentials,
			});

			expect(captured.options!.workStealing).toBeTrue();
			expect(captured.options!.parallel).toBe("auto");
		});

		it("should fall back to the single-task path when the queue cannot be prepared", async () => {
			expect.assertions(4);

			prepareWorkStealingQueue.mockRejectedValue(
				new Error("Failed to enqueue work item: insufficient scope"),
			);
			const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			const { captured, output } = await runStealingFooAsync({
				runOptions: makeRunOptions({ parallel: 3 }),
				workStealingCredentials: testCredentials,
			});

			expect(captured.options!.workStealing).toBeUndefined();
			expect(captured.options!.scriptFactory).toBeDefined();
			expect(output!.results).toHaveLength(1);
			expect(warn.mock.calls.flat().join("")).toContain("insufficient scope");
		});

		it("should keep the existing single-task path when parallel is unset", async () => {
			expect.assertions(2);

			const { captured } = await runStealingFooAsync({
				runOptions: makeRunOptions(),
				workStealingCredentials: testCredentials,
			});

			expect(captured.options!.workStealing).toBeUndefined();
			expect(prepareWorkStealingQueue).not.toHaveBeenCalled();
		});

		it("should keep the existing path when workStealingCredentials is not provided even with parallel>1", async () => {
			expect.assertions(2);

			const { captured } = await runStealingFooAsync({
				runOptions: makeRunOptions({ parallel: 4 }),
			});

			expect(captured.options!.workStealing).toBeUndefined();
			expect(dispatchedScript(captured)).not.toContain('"queueId"');
		});

		it("should forward workStealingCredentials.baseUrl into prepareWorkStealingQueue", async () => {
			expect.assertions(1);

			const { fileSystem } = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
				[FOO_DIR]: rooted(FOO_DIR),
			});

			mockPreparedQueue("queue-base-url");
			const { backend } = createStubBackend(passingEntries("@halcyon/foo"));

			await runStealingWorkspaceAsync({
				backend,
				cli: makeCli(),
				fileSystem,
				/**
				 * Exercise the streaming-side baseUrl plumbing on the same
				 * call; keeps the SortedMap client constructor seeing the
				 * override when work-stealing fires.
				 */
				onStreamingResult: () => {
					/* intentionally inert */
				},
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ parallel: 2 }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
				workStealingCredentials: {
					...testCredentials,
					baseUrl: "http://127.0.0.1:4010",
				},
			});

			expect(prepareWorkStealingQueue.mock.calls[0]![0].baseUrl).toBe(
				"http://127.0.0.1:4010",
			);
		});

		it("should provide a streaming reader and onPackageResult to the backend when onStreamingResult is set", async () => {
			expect.assertions(2);

			mockPreparedQueue("queue-stream");
			const { captured } = await runStealingFooAsync({
				onStreamingResult: () => {
					/* intentionally inert */
				},
				runOptions: makeRunOptions({ parallel: 2 }),
				workStealingCredentials: testCredentials,
			});

			expect(captured.options!.streaming!.reader).toBeDefined();
			expect(captured.options!.streaming!.onPackageResult).toBeFunction();
		});

		it("should embed a sortedMapId in the work-stealing script when onStreamingResult is set", async () => {
			expect.assertions(1);

			mockPreparedQueue("queue-stream");
			const { captured } = await runStealingFooAsync({
				onStreamingResult: () => {
					/* intentionally inert */
				},
				runOptions: makeRunOptions({ parallel: 2 }),
				workStealingCredentials: testCredentials,
			});

			expect(captured.options!.scriptOverride).toContain('"sortedMapId":');
		});

		// A bailed run comes back short by design. The packages it never reached
		// must drop out of the results rather than pair with a sibling's entry,
		// and they must be named so the report can say the run stopped early.
		it("should drop the packages a bailed run never reached", async () => {
			expect.assertions(3);

			const { fileSystem } = stageWorkspace(fooBarFiles(), {
				[BAR_DIR]: rooted(BAR_DIR),
				[FOO_DIR]: rooted(FOO_DIR),
			});

			mockPreparedQueue("queue-bailed");
			const { backend } = createStubBackend(
				[{ jestOutput: passingResult(), pkg: "@halcyon/bar" }],
				{ bailedJobIndices: [0] },
			);

			const output = await runStealingWorkspaceAsync({
				backend,
				cli: makeCli(),
				fileSystem,
				packageInfos: [FOO_INFO, BAR_INFO],
				runOptions: makeRunOptions({ bail: true, parallel: 2 }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
				workStealingCredentials: testCredentials,
			});

			expect(output!.results).toHaveLength(1);
			expect(output!.results[0]!.pkg).toBe("@halcyon/bar");
			expect(output!.bailedPackages).toStrictEqual(["@halcyon/foo"]);
		});

		// A package with several projects is one package. When a bail stops it
		// part-way, the package RAN — naming it as not-run too would report the
		// same package on both sides of the count.
		it("should not report a partly-run package as one the bail skipped", async () => {
			expect.assertions(2);

			const { fileSystem } = stageWorkspace(
				{
					...seedPackage(FOO_DIR, {
						name: "@halcyon/foo",
						specFiles: {
							[path.join(FOO_DIR, "out/Client/a.spec.luau")]: "",
							[path.join(FOO_DIR, "out/Server/b.spec.luau")]: "",
						},
						tree: {
							$className: "DataModel",
							ReplicatedStorage: { Client: { $path: "out/Client" } },
							ServerScriptService: { Server: { $path: "out/Server" } },
						},
					}),
				},
				{
					[FOO_DIR]: rooted(FOO_DIR, {
						projects: makeProjectEntries([
							{
								test: {
									displayName: "client",
									include: ["out/Client/**/*.spec.luau"],
								},
							},
							{
								test: {
									displayName: "server",
									include: ["out/Server/**/*.spec.luau"],
								},
							},
						]),
					}),
				},
			);

			mockPreparedQueue("queue-partial");
			const { backend } = createStubBackend([passingProjectEntry("@halcyon/foo", "client")], {
				bailedJobIndices: [1],
			});

			const output = await runStealingWorkspaceAsync({
				backend,
				cli: makeCli(),
				fileSystem,
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ bail: true, parallel: 2 }),
				version: "0.0.0-test",
				workspaceRoot: ROOT,
				workStealingCredentials: testCredentials,
			});

			expect(output!.results).toHaveLength(1);
			expect(output!.bailedPackages).toBeUndefined();
		});

		it("should embed bail in the work-stealing script when --bail is set", async () => {
			expect.assertions(1);

			mockPreparedQueue("queue-bail");
			const { captured } = await runStealingFooAsync({
				runOptions: makeRunOptions({ bail: true, parallel: 2 }),
				workStealingCredentials: testCredentials,
			});

			expect(captured.options!.scriptOverride).toContain('"bail":true');
		});

		// Parallel tasks broadcast the trip through a map of their own, so --bail
		// needs one even on a run whose formatter never asked to stream.
		it("should create a signal map for the bail without a streaming consumer", async () => {
			expect.assertions(1);

			mockPreparedQueue("queue-bail-map");
			const { captured } = await runStealingFooAsync({
				runOptions: makeRunOptions({ bail: true, parallel: 2 }),
				workStealingCredentials: testCredentials,
			});

			expect(captured.options!.scriptOverride).toContain('"bailMapId":');
		});

		it("should skip streaming setup when onStreamingResult is omitted (no SortedMap polling overhead)", async () => {
			expect.assertions(2);

			mockPreparedQueue("queue-stream");
			const { captured } = await runStealingFooAsync({
				runOptions: makeRunOptions({ parallel: 2 }),
				workStealingCredentials: testCredentials,
			});

			expect(captured.options!.streaming).toBeUndefined();
			expect(captured.options!.scriptOverride).not.toContain('"sortedMapId":');
		});

		it("should route streaming entries through the supplied onStreamingResult", async () => {
			expect.assertions(1);

			const { fileSystem } = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
				[FOO_DIR]: rooted(FOO_DIR),
			});

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

			const { backend } = createStubBackend(passingEntries("@halcyon/foo"));
			// Wrap the stub so it invokes the streaming hook before returning,
			// simulating an entry observed mid-task.
			const wrappedBackend: Backend = {
				kind: "open-cloud",
				placeInput: "built",
				runTestsAsync: async (options) => {
					options.streaming!.onPackageResult(streamedEntry);
					return backend.runTestsAsync(options);
				},
			};

			await runStealingWorkspaceAsync({
				backend: wrappedBackend,
				cli: makeCli(),
				fileSystem,
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

			const { volume } = await runScenarioAsync({
				configs: {
					[FOO_DIR]: rooted(FOO_DIR),
				},
				entries: passingEntries("@halcyon/foo"),
				files: seedSpec(FOO_INFO, "src/foo.spec.luau"),
				run: {
					packageInfos: [FOO_INFO],
					runOptions: makeRunOptions({ workspaceOutputFile: true }),
				},
			});

			const file = path.join(
				ROOT,
				".jest-roblox",
				"output",
				"@halcyon-foo--@halcyon-foo.jest-output.log",
			);

			expect(volume.existsSync(file)).toBeTrue();
			expect(JSON.parse(volume.readFileSync(file, "utf-8").toString())).toMatchObject({
				numFailedTests: 0,
				numPassedTests: 1,
				success: true,
			});
		});

		it("should sanitize filesystem-unsafe characters in pkg/project segments", async () => {
			expect.assertions(1);

			const { volume } = await runScenarioAsync({
				configs: {
					[FOO_DIR]: rooted(FOO_DIR),
				},
				entries: passingEntries("@halcyon/foo"),
				files: seedSpec(FOO_INFO, "src/foo.spec.luau"),
				run: {
					packageInfos: [FOO_INFO],
					runOptions: makeRunOptions({ workspaceOutputFile: true }),
				},
			});

			// `@halcyon/foo` → `@halcyon-foo`; slashes and other unsafe chars
			// become hyphens so the path component stays a single segment.
			expect(
				volume.existsSync(
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

			const { volume } = await runScenarioAsync({
				configs: {
					[FOO_DIR]: rooted(FOO_DIR),
				},
				entries: passingEntries("@halcyon/foo"),
				files: seedSpec(FOO_INFO, "src/foo.spec.luau"),
				run: {
					packageInfos: [FOO_INFO],
				},
			});

			expect(
				volume.existsSync(
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

	describe("per-package output files (type tests)", () => {
		it("should write a package's type test result to .jest-roblox/output/<pkg>--<project>.jest-output.log under --typecheckOnly", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = stagePassingTypecheckFoo();

			const { backend } = createStubBackend([]);

			await runStagedWorkspaceAsync({
				backend,
				cli: makeCli({ typecheckOnly: true }),
				fileSystem,
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ workspaceOutputFile: true }),
			});

			const file = path.join(
				ROOT,
				".jest-roblox",
				"output",
				"@halcyon-foo--@halcyon-foo.jest-output.log",
			);

			expect(volume.existsSync(file)).toBeTrue();
			expect(JSON.parse(volume.readFileSync(file, "utf-8").toString())).toMatchObject({
				success: true,
				testResults: [{ testFilePath: "@halcyon/foo/src/foo.spec-d.ts" }],
			});
		});

		it("should merge the type test result into the per-package file alongside runtime results", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = stagePassingTypecheckFoo();

			const { backend } = createStubBackend([
				passingProjectEntry("@halcyon/foo", "@halcyon/foo"),
			]);

			await runStagedWorkspaceAsync({
				backend,
				fileSystem,
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ workspaceOutputFile: true }),
			});

			const file = path.join(
				ROOT,
				".jest-roblox",
				"output",
				"@halcyon-foo--@halcyon-foo.jest-output.log",
			);

			expect(JSON.parse(volume.readFileSync(file, "utf-8").toString())).toStrictEqual({
				numFailedTests: 0,
				numPassedTests: 2,
				numPendingTests: 0,
				numTodoTests: 0,
				numTotalTests: 2,
				startTime: 0,
				success: true,
				testResults: [
					{
						numFailingTests: 0,
						numPassingTests: 1,
						numPendingTests: 0,
						testFilePath: "@halcyon/foo/src/foo.spec-d.ts",
						testResults: [],
					},
				],
			});
		});
	});

	describe("per-package gameOutput files", () => {
		async function runGameOutputFooAsync(
			gameOutput: string | undefined,
			runOptions: Partial<WorkspaceRunOptions>,
		) {
			return runScenarioAsync({
				configs: { [FOO_DIR]: rooted(FOO_DIR) },
				entries: [
					gameOutput === undefined
						? { jestOutput: passingResult(), pkg: "@halcyon/foo" }
						: { gameOutput, jestOutput: passingResult(), pkg: "@halcyon/foo" },
				],
				files: seedSpec(FOO_INFO, "src/foo.spec.luau"),
				run: { packageInfos: [FOO_INFO], runOptions: makeRunOptions(runOptions) },
			});
		}

		it("should write parsed entries to .jest-roblox/output/<pkg>--<project>.game-output.log when workspace.gameOutput is enabled", async () => {
			expect.assertions(2);

			const { volume } = await runGameOutputFooAsync(
				JSON.stringify([{ message: "hello", messageType: 0, timestamp: 1000 }]),
				{ workspaceGameOutput: true },
			);

			const file = path.join(
				ROOT,
				".jest-roblox",
				"output",
				"@halcyon-foo--@halcyon-foo.game-output.log",
			);

			expect(volume.existsSync(file)).toBeTrue();
			expect(JSON.parse(volume.readFileSync(file, "utf-8").toString())).toStrictEqual([
				{ message: "hello", messageType: 0, timestamp: 1000 },
			]);
		});

		it("should NOT write per-package gameOutput files when workspace.gameOutput is disabled", async () => {
			expect.assertions(2);

			const { volume } = await runGameOutputFooAsync(
				JSON.stringify([{ message: "hello", messageType: 0, timestamp: 1000 }]),
				{ workspaceOutputFile: true },
			);

			// The two per-package sinks are independent: with
			// workspace.outputFile on, the result JSON sibling is emitted, but
			// the .game-output.log companion stays absent because
			// workspace.gameOutput is off.
			expect(
				volume.existsSync(
					path.join(
						ROOT,
						".jest-roblox",
						"output",
						"@halcyon-foo--@halcyon-foo.jest-output.log",
					),
				),
			).toBeTrue();
			expect(
				volume.existsSync(
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

			const { volume } = await runGameOutputFooAsync(undefined, {
				workspaceGameOutput: true,
			});

			const file = path.join(
				ROOT,
				".jest-roblox",
				"output",
				"@halcyon-foo--@halcyon-foo.game-output.log",
			);

			expect(JSON.parse(volume.readFileSync(file, "utf-8").toString())).toStrictEqual([]);
		});

		it("should write an empty array when the package's gameOutput is invalid JSON", async () => {
			expect.assertions(1);

			const { volume } = await runGameOutputFooAsync("not-json", {
				workspaceGameOutput: true,
			});

			const file = path.join(
				ROOT,
				".jest-roblox",
				"output",
				"@halcyon-foo--@halcyon-foo.game-output.log",
			);

			expect(JSON.parse(volume.readFileSync(file, "utf-8").toString())).toStrictEqual([]);
		});

		// A failure envelope synthesizes an ExecuteResult
		// via executor.ts:482 carrying the per-entry gameOutput, so the
		// failed package's captured logs are NOT lost.
		it("should still write per-package gameOutput files when one entry's envelope is a failure", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = stageWorkspace(fooBarFiles(), {
				[BAR_DIR]: rooted(BAR_DIR, { silent: true }),
				[FOO_DIR]: rooted(FOO_DIR, { silent: true }),
			});

			const failureEnvelope = JSON.stringify({
				err: "Exited with code: 1",
				success: false,
			});
			const fooGameOutput = JSON.stringify([
				{ message: "captured before crash", messageType: 2, timestamp: 5 },
			]);

			const { backend } = createStubBackend([
				{
					gameOutput: fooGameOutput,
					jestOutput: failureEnvelope,
					pkg: "@halcyon/foo",
				},
				{ jestOutput: passingResult(), pkg: "@halcyon/bar" },
			]);

			await runStagedWorkspaceAsync({
				backend,
				fileSystem,
				packageInfos: [FOO_INFO, BAR_INFO],
				runOptions: makeRunOptions({ silent: true, workspaceGameOutput: true }),
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

			expect(JSON.parse(volume.readFileSync(fooFile, "utf-8").toString())).toStrictEqual([
				{ message: "captured before crash", messageType: 2, timestamp: 5 },
			]);
			expect(JSON.parse(volume.readFileSync(barFile, "utf-8").toString())).toStrictEqual([]);
		});

		it("should emit a separate gameOutput file per project for multi-project packages", async () => {
			expect.assertions(4);

			const projects = makeProjectEntries([
				{
					test: {
						displayName: "client",
						include: ["out/Client/**/*.spec.luau"],
					},
				},
				{
					test: {
						displayName: "server",
						include: ["out/Server/**/*.spec.luau"],
					},
				},
			]);
			const { fileSystem, volume } = stageWorkspace(clientServerFooFiles(), {
				[FOO_DIR]: rooted(FOO_DIR, { projects }),
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

			await runStagedWorkspaceAsync({
				backend,
				fileSystem,
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ workspaceGameOutput: true }),
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

			expect(volume.existsSync(clientFile)).toBeTrue();
			expect(volume.existsSync(serverFile)).toBeTrue();
			expect(JSON.parse(volume.readFileSync(clientFile, "utf-8").toString())).toStrictEqual([
				{ message: "client", messageType: 0, timestamp: 1 },
			]);
			expect(JSON.parse(volume.readFileSync(serverFile, "utf-8").toString())).toStrictEqual([
				{ message: "server", messageType: 1, timestamp: 2 },
			]);
		});
	});

	describe("aggregated gameOutput", () => {
		async function announceAsync(runOptions: Partial<WorkspaceRunOptions>) {
			const { fileSystem } = seedFoo();
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const { backend } = createStubBackend([
				{ gameOutput: helloRaw, jestOutput: passingResult(), pkg: "@halcyon/foo" },
			]);

			await runStagedWorkspaceAsync({
				backend,
				fileSystem,
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions(runOptions),
			});
			return errorSpy;
		}

		function seedFoo(): MemoryFileSystem {
			const memory = createMemoryFileSystem();

			memory.volume.fromJSON({
				...seedSpec(FOO_INFO, "src/foo.spec.luau"),
				...WORKSPACE_YAML,
			});
			setLoadedConfigPerPackage({
				[FOO_DIR]: rooted(FOO_DIR),
			});
			return memory;
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

			const { fileSystem, volume } = seedFoo();
			const { backend } = createStubBackend([
				{
					gameOutput: helloRaw,
					jestOutput: passingResult(),
					pkg: "@halcyon/foo",
				},
			]);

			await runStagedWorkspaceAsync({
				backend,
				fileSystem,
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ gameOutput: aggregateFile, silent: true }),
			});

			expect(
				JSON.parse(volume.readFileSync(aggregateFile, "utf-8").toString()),
			).toStrictEqual([
				{
					entries: [{ message: "hello", messageType: 0, timestamp: 1000 }],
					package: "@halcyon/foo",
					project: "@halcyon/foo",
				},
			]);
		});

		it("should write both the aggregate and per-package files when both are enabled", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = seedFoo();
			const { backend } = createStubBackend([
				{
					gameOutput: helloRaw,
					jestOutput: passingResult(),
					pkg: "@halcyon/foo",
				},
			]);

			await runStagedWorkspaceAsync({
				backend,
				fileSystem,
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({
					gameOutput: aggregateFile,
					silent: true,
					workspaceGameOutput: true,
				}),
			});

			expect(volume.existsSync(aggregateFile)).toBeTrue();
			expect(volume.existsSync(perPackageFile)).toBeTrue();
		});

		it("should announce only the aggregate to humans when both sinks are active", async () => {
			expect.assertions(2);

			const errorSpy = await announceAsync({
				formatters: ["default"],
				gameOutput: aggregateFile,
				workspaceGameOutput: true,
			});

			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(aggregateFile));
			expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining(perPackageFile));
		});

		it("should announce per-package files to agents when both sinks are active", async () => {
			expect.assertions(2);

			const errorSpy = await announceAsync({
				formatters: ["agent"],
				gameOutput: aggregateFile,
				workspaceGameOutput: true,
			});

			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(perPackageFile));
			expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining(aggregateFile));
		});

		it("should announce per-package paths to humans when only per-package is active", async () => {
			expect.assertions(1);

			const errorSpy = await announceAsync({
				formatters: ["default"],
				workspaceGameOutput: true,
			});

			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(perPackageFile));
		});

		it("should announce the aggregate to agents when only the aggregate is active", async () => {
			expect.assertions(1);

			const errorSpy = await announceAsync({
				formatters: ["agent"],
				gameOutput: aggregateFile,
			});

			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(aggregateFile));
		});

		it("should not announce the aggregate when it captured zero entries", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = seedFoo();
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const { backend } = createStubBackend(passingEntries("@halcyon/foo"));

			await runStagedWorkspaceAsync({
				backend,
				fileSystem,
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({
					formatters: ["default"],
					gameOutput: aggregateFile,
				}),
			});

			// File still written (empty group), but no notice for zero entries.
			expect(volume.existsSync(aggregateFile)).toBeTrue();
			expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining(aggregateFile));
		});
	});

	describe("aggregated outputFile", () => {
		it("should write the merged result to runOptions.outputFile", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
				[FOO_DIR]: rooted(FOO_DIR),
			});

			const { backend } = createStubBackend(passingEntries("@halcyon/foo"));
			const outputFile = path.join(ROOT, "jest-output.log");

			await runStagedWorkspaceAsync({
				backend,
				fileSystem,
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ outputFile, silent: true }),
			});

			expect(volume.existsSync(outputFile)).toBeTrue();
			expect(JSON.parse(volume.readFileSync(outputFile, "utf-8").toString())).toMatchObject({
				numPassedTests: 1,
				success: true,
			});
		});

		it("should not write a result file when runOptions.outputFile is unset", async () => {
			expect.assertions(1);

			const { volume } = await runScenarioAsync({
				configs: {
					[FOO_DIR]: rooted(FOO_DIR),
				},
				entries: passingEntries("@halcyon/foo"),
				files: seedSpec(FOO_INFO, "src/foo.spec.luau"),
				run: {
					packageInfos: [FOO_INFO],
					runOptions: makeRunOptions({ silent: true }),
				},
			});

			expect(volume.existsSync(path.join(ROOT, "jest-output.log"))).toBeFalse();
		});

		it("should write the type test result to runOptions.outputFile under --typecheckOnly", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = stagePassingTypecheckFoo();

			const { backend } = createStubBackend([
				passingProjectEntry("@halcyon/foo", "@halcyon/foo"),
			]);
			const outputFile = path.join(ROOT, "jest-output.log");

			await runStagedWorkspaceAsync({
				backend,
				cli: makeCli({ typecheckOnly: true }),
				fileSystem,
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ outputFile, silent: true }),
			});

			expect(volume.existsSync(outputFile)).toBeTrue();
			expect(JSON.parse(volume.readFileSync(outputFile, "utf-8").toString())).toMatchObject({
				testResults: [{ testFilePath: "@halcyon/foo/src/foo.spec-d.ts" }],
			});
		});

		it("should merge the type test result into runOptions.outputFile alongside runtime results", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = stagePassingTypecheckFoo();

			const { backend } = createStubBackend([
				passingProjectEntry("@halcyon/foo", "@halcyon/foo"),
			]);
			const outputFile = path.join(ROOT, "jest-output.log");

			await runStagedWorkspaceAsync({
				backend,
				fileSystem,
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ outputFile, silent: true }),
			});

			expect(JSON.parse(volume.readFileSync(outputFile, "utf-8").toString())).toMatchObject({
				numPassedTests: 2,
				testResults: [{ testFilePath: "@halcyon/foo/src/foo.spec-d.ts" }],
			});
		});
	});

	describe("snapshot writeback", () => {
		it("should route each package's envelope snapshotWrites to its own package directory without cross-package leak", async () => {
			expect.assertions(4);

			const { volume } = await runScenarioAsync({
				configs: {
					[BAR_DIR]: rooted(BAR_DIR, { silent: true }),
					[FOO_DIR]: rooted(FOO_DIR, { silent: true }),
				},
				entries: [
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
				],
				files: fooBarFiles(),
				run: {
					packageInfos: [FOO_INFO, BAR_INFO],
					runOptions: makeRunOptions({ silent: true }),
				},
			});

			const fooSnap = path.join(FOO_DIR, "src/__snapshots__/foo.spec.snap.luau");
			const barSnap = path.join(BAR_DIR, "src/__snapshots__/bar.spec.snap.luau");

			expect(volume.readFileSync(fooSnap, "utf8")).toBe("foo-snap-content");
			expect(volume.readFileSync(barSnap, "utf8")).toBe("bar-snap-content");

			// No cross-package leak: foo's snapshot path does not appear under
			// bar's tree, and vice versa.
			expect(
				volume.existsSync(path.join(BAR_DIR, "src/__snapshots__/foo.spec.snap.luau")),
			).toBeFalse();
			expect(
				volume.existsSync(path.join(FOO_DIR, "src/__snapshots__/bar.spec.snap.luau")),
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

			const { fileSystem, volume } = stageWorkspace(fooBarFiles(), {
				[BAR_DIR]: rooted(BAR_DIR, { silent: true }),
				[FOO_DIR]: rooted(FOO_DIR, { silent: true }),
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

			await runStagedWorkspaceAsync({
				backend,
				fileSystem,
				packageInfos: [FOO_INFO, BAR_INFO],
				runOptions: makeRunOptions({ silent: true, workspaceOutputFile: true }),
			});

			// bar's snapshot lands even though foo's envelope failed.
			expect(
				volume.readFileSync(
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

			expect(volume.existsSync(fooOutput)).toBeTrue();
			expect(volume.existsSync(barOutput)).toBeTrue();
			expect(JSON.parse(volume.readFileSync(fooOutput, "utf-8").toString())).toMatchObject({
				success: false,
			});
			expect(JSON.parse(volume.readFileSync(barOutput, "utf-8").toString())).toMatchObject({
				numPassedTests: 1,
				success: true,
			});
		});
	});
});

function makeTypeResult(overrides: Partial<JestResult> = {}): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: 0,
		success: true,
		testResults: [],
		...overrides,
	};
}

describe("workspace type tests", () => {
	it("should discover a package's -d type tests via the derived include and return a typecheckResult", async () => {
		expect.assertions(2);

		const { fileSystem } = stageWorkspace(
			seedSpec(FOO_INFO, "src/foo.spec-d.ts", "src/foo.spec.ts"),
			{
				[FOO_DIR]: rooted(FOO_DIR, {
					testMatch: ["**/*.spec.ts"],
					typecheck: {
						enabled: true,
						ignoreSourceErrors: false,
						spawnTimeout: 4321,
					},
				}),
			},
		);

		runTypecheck.mockResolvedValue(makeTypeResult());

		const { backend } = createStubBackend([
			passingProjectEntry("@halcyon/foo", "@halcyon/foo"),
		]);

		const result = await runStagedWorkspaceAsync({
			backend,
			fileSystem,
			packageInfos: [FOO_INFO],
		});

		expect(runTypecheck).toHaveBeenCalledWith(
			expect.objectContaining({
				files: expect.arrayContaining([expect.stringMatching(/foo\.spec-d\.ts$/)]),
				ignoreSourceErrors: false,
				spawnTimeout: 4321,
			}),
		);
		expect(result!.typecheckResult).toBeDefined();
	});

	it("should reject typescript type tests in the standalone binary before staging or dispatch", async () => {
		expect.assertions(4);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");
		const { fileSystem } = stageWorkspace(
			seedSpec(FOO_INFO, "src/foo.spec-d.ts", "src/foo.spec.ts"),
			{
				[FOO_DIR]: rooted(FOO_DIR, {
					testMatch: ["**/*.spec.ts"],
					typecheck: { enabled: true },
				}),
			},
		);

		const { backend } = createStubBackend([
			passingProjectEntry("@halcyon/foo", "@halcyon/foo"),
		]);
		const runTests = vi.spyOn(backend, "runTestsAsync");

		const error: unknown = await runStagedWorkspaceAsync({
			backend,
			fileSystem,
			packageInfos: [FOO_INFO],
		}).catch((err: unknown) => err);

		expect(error).toStrictEqual(
			configErrorLike(
				"--typecheck is not available in the standalone binary. Install via npm instead.",
				undefined,
			),
		);
		expect(fileSystem.existsSync(SYNTHESIZED_PROJECT)).toBeFalse();
		expect(runTests).not.toHaveBeenCalled();
		expect(runTypecheck).not.toHaveBeenCalled();
	});

	it("should skip discovered type test files when typechecking is disabled", async () => {
		expect.assertions(2);

		const { fileSystem } = stageWorkspace(
			seedSpec(FOO_INFO, "src/foo.spec-d.ts", "src/foo.spec.ts"),
			{
				[FOO_DIR]: rooted(FOO_DIR, {
					testMatch: ["**/*.spec.ts"],
					typecheck: { enabled: false },
				}),
			},
		);

		runTypecheck.mockResolvedValue(makeTypeResult());

		const { backend } = createStubBackend([
			passingProjectEntry("@halcyon/foo", "@halcyon/foo"),
		]);

		const result = await runStagedWorkspaceAsync({
			backend,
			fileSystem,
			packageInfos: [FOO_INFO],
		});

		assert(result !== undefined);

		expect(runTypecheck).not.toHaveBeenCalled();

		expect(result.typecheckResult).toBeUndefined();
	});

	// The positional selects the type pass as well, so naming one type test
	// checks that file rather than every `-d` file in the package it lives in.
	it("should check only the type test a positional file names", async () => {
		expect.assertions(1);

		const { fileSystem } = stageWorkspace(
			seedSpec(FOO_INFO, "src/other.spec-d.ts", "src/wanted.spec-d.ts"),
			{
				[FOO_DIR]: rooted(FOO_DIR, {
					testMatch: ["**/*.spec.ts"],
					typecheck: { enabled: true },
				}),
			},
		);

		runTypecheck.mockResolvedValue(makeTypeResult());

		const { backend } = createStubBackend([]);

		await runStagedWorkspaceAsync({
			backend,
			cli: makeCli({ files: [path.join(FOO_DIR, "src/wanted.spec-d.ts")] }),
			fileSystem,
			packageInfos: [FOO_INFO],
		});

		const { files } = runTypecheck.mock.calls[0]![0];

		// Absolute and platform-native, the same shape the glob half produces —
		// the two feed one tsgo group, and the ownership match that selected
		// this file hands back a posix path.
		expect(files).toStrictEqual([path.join(FOO_DIR, "src/wanted.spec-d.ts")]);
	});

	// The mirror of the case above: a runtime positional leaves the package's
	// type tests out entirely, rather than checking them alongside the one file
	// the user named.
	it("should skip the type pass when a positional file names a runtime spec", async () => {
		expect.assertions(1);

		await runScenarioAsync({
			configs: {
				[FOO_DIR]: rooted(FOO_DIR, {
					testMatch: ["**/*.spec.ts"],
					typecheck: { enabled: true },
				}),
			},
			entries: [passingProjectEntry("@halcyon/foo", "@halcyon/foo")],
			files: seedSpec(FOO_INFO, "src/foo.spec-d.ts", "src/foo.spec.ts"),
			run: {
				cli: makeCli({ files: [path.join(FOO_DIR, "src/foo.spec.ts")] }),
				packageInfos: [FOO_INFO],
			},
		});

		expect(runTypecheck).not.toHaveBeenCalled();
	});

	it("should use an explicit test.typecheck.include instead of deriving from the runtime include", async () => {
		expect.assertions(2);

		const files = await typecheckFooFilesAsync(
			{ enabled: true, include: ["src/types/**/*.spec-d.ts"] },
			"src/foo.spec-d.ts",
			"src/foo.spec.ts",
			"src/types/x.spec-d.ts",
		);

		expect(files.some((file) => file.endsWith("x.spec-d.ts"))).toBeTrue();
		expect(files.some((file) => file.endsWith("foo.spec-d.ts"))).toBeFalse();
	});

	it("should subtract test.typecheck.exclude from the discovered type tests", async () => {
		expect.assertions(2);

		const files = await typecheckFooFilesAsync(
			{ enabled: true, exclude: ["src/**/*.gen.spec-d.ts"] },
			"src/a.gen.spec-d.ts",
			"src/a.spec-d.ts",
			"src/a.spec.ts",
		);

		expect(files.some((file) => file.endsWith("a.spec-d.ts"))).toBeTrue();
		expect(files.some((file) => file.endsWith("a.gen.spec-d.ts"))).toBeFalse();
	});

	it("should collapse multi-project packages sharing a tsconfig into one tsgo group at the package directory", async () => {
		expect.assertions(1);

		const projects = makeProjectEntries([
			{ test: { displayName: "client", include: ["out/Client/**/*.spec.ts"] } },
			{ test: { displayName: "server", include: ["out/Server/**/*.spec.ts"] } },
		]);
		const { fileSystem } = stageWorkspace(
			{
				...seedPackage(FOO_DIR, {
					name: "@halcyon/foo",
					specFiles: {
						[path.join(FOO_DIR, "out/Client/a.spec-d.ts")]: "",
						[path.join(FOO_DIR, "out/Client/a.spec.ts")]: "",
						[path.join(FOO_DIR, "out/Server/b.spec-d.ts")]: "",
						[path.join(FOO_DIR, "out/Server/b.spec.ts")]: "",
					},
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { Client: { $path: "out/Client" } },
						ServerScriptService: { Server: { $path: "out/Server" } },
					},
				}),
			},
			{
				[FOO_DIR]: rooted(FOO_DIR, {
					projects,
					typecheck: { enabled: true, tsconfig: "tsconfig.types.json" },
				}),
			},
		);

		runTypecheck.mockResolvedValue(makeTypeResult());

		const { backend } = createStubBackend([
			passingProjectEntry("@halcyon/foo", "client"),
			passingProjectEntry("@halcyon/foo", "server"),
		]);

		await runStagedWorkspaceAsync({
			backend,
			fileSystem,
			packageInfos: [FOO_INFO],
		});

		expect(runTypecheck).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				files: [expect.any(String), expect.any(String)],
				rootDir: FOO_DIR,
			}),
		);
	});

	it("should form distinct groups per package even when they share the same relative tsconfig name", async () => {
		expect.assertions(3);

		const { fileSystem } = stageWorkspace(
			{
				...seedSpec(FOO_INFO, "src/index.spec-d.ts", "src/index.spec.ts"),
				...seedSpec(BAR_INFO, "src/index.spec-d.ts", "src/index.spec.ts"),
			},
			{
				[BAR_DIR]: rooted(BAR_DIR, {
					testMatch: ["**/*.spec.ts"],
					typecheck: { enabled: true, tsconfig: "tsconfig.types.json" },
				}),
				[FOO_DIR]: rooted(FOO_DIR, {
					testMatch: ["**/*.spec.ts"],
					typecheck: { enabled: true, tsconfig: "tsconfig.types.json" },
				}),
			},
		);

		runTypecheck.mockResolvedValue(makeTypeResult());

		const { backend } = createStubBackend([
			passingProjectEntry("@halcyon/foo", "@halcyon/foo"),
			passingProjectEntry("@halcyon/bar", "@halcyon/bar"),
		]);

		await runStagedWorkspaceAsync({
			backend,
			fileSystem,
			packageInfos: [FOO_INFO, BAR_INFO],
		});

		expect(runTypecheck).toHaveBeenCalledTimes(2);

		const rootDirectories = runTypecheck.mock.calls.map((call) => call[0].rootDir).sort();

		expect(rootDirectories).toStrictEqual([BAR_DIR, FOO_DIR].sort());
		expect(
			runTypecheck.mock.calls.every((call) => call[0].tsconfig === "tsconfig.types.json"),
		).toBeTrue();
	});

	it("should compose package identity onto each merged type test file result", async () => {
		expect.assertions(2);

		const { fileSystem } = stageWorkspace(
			{
				...seedSpec(FOO_INFO, "src/index.spec-d.ts", "src/index.spec.ts"),
				...seedSpec(BAR_INFO, "src/index.spec-d.ts", "src/index.spec.ts"),
			},
			{
				[BAR_DIR]: rooted(BAR_DIR, {
					testMatch: ["**/*.spec.ts"],
					typecheck: { enabled: true },
				}),
				[FOO_DIR]: rooted(FOO_DIR, {
					testMatch: ["**/*.spec.ts"],
					typecheck: { enabled: true },
				}),
			},
		);

		// Each group's tsgo returns the SAME package-relative file path; identity
		// composition must keep the two packages' results distinguishable.
		runTypecheck.mockResolvedValue(
			makeTypeResult({
				testResults: [
					{
						numFailingTests: 0,
						numPassingTests: 1,
						numPendingTests: 0,
						testFilePath: "src/index.spec-d.ts",
						testResults: [],
					},
				],
			}),
		);

		const { backend } = createStubBackend([
			passingProjectEntry("@halcyon/foo", "@halcyon/foo"),
			passingProjectEntry("@halcyon/bar", "@halcyon/bar"),
		]);

		const result = await runStagedWorkspaceAsync({
			backend,
			fileSystem,
			packageInfos: [FOO_INFO, BAR_INFO],
		});

		const paths = result!.typecheckResult!.testResults.map((file) => file.testFilePath);

		expect(paths).toContain("@halcyon/foo/src/index.spec-d.ts");
		expect(paths).toContain("@halcyon/bar/src/index.spec-d.ts");
	});

	it("should run the type pass concurrently with the Open Cloud run", async () => {
		expect.assertions(1);

		const { fileSystem } = stageWorkspace(
			seedSpec(FOO_INFO, "src/foo.spec-d.ts", "src/foo.spec.ts"),
			{
				[FOO_DIR]: rooted(FOO_DIR, {
					testMatch: ["**/*.spec.ts"],
					typecheck: { enabled: true },
				}),
			},
		);

		// A rendezvous: each side proceeds only once the other has started, so
		// the run completes only when the two overlap. A strictly-sequential pass
		// would deadlock (one side awaits a signal that never fires).
		let signalRuntimeStarted!: () => void;
		let signalTypecheckStarted!: () => void;
		const runtimeStarted = new Promise<void>((resolve) => {
			signalRuntimeStarted = resolve;
		});
		const typecheckStarted = new Promise<void>((resolve) => {
			signalTypecheckStarted = resolve;
		});
		const backend: Backend = {
			kind: "open-cloud",
			placeInput: "built",
			runTestsAsync: async (): Promise<BackendResult> => {
				signalRuntimeStarted();
				await typecheckStarted;
				return {
					rawResults: [{ entry: { jestOutput: passingResult(), pkg: "@halcyon/foo" } }],
					timing: { executionMs: 0, uploadMs: 0 },
				};
			},
		};
		runTypecheck.mockImplementation(async () => {
			signalTypecheckStarted();
			await runtimeStarted;
			return makeTypeResult();
		});

		const result = await runStagedWorkspaceAsync({
			backend,
			fileSystem,
			packageInfos: [FOO_INFO],
		});

		expect(result!.typecheckResult).toBeDefined();
	});

	it("should short-circuit --typecheckOnly: no place build, no backend dispatch, only the type pass", async () => {
		expect.assertions(4);

		const { fileSystem } = stageWorkspace(
			seedSpec(FOO_INFO, "src/foo.spec-d.ts", "src/foo.spec.ts"),
			{
				[FOO_DIR]: rooted(FOO_DIR, { testMatch: ["**/*.spec.ts"] }),
			},
		);

		runTypecheck.mockResolvedValue(makeTypeResult());

		const { backend, captured } = createStubBackend([
			passingProjectEntry("@halcyon/foo", "@halcyon/foo"),
		]);

		const result = await runStagedWorkspaceAsync({
			backend,
			cli: makeCli({ typecheckOnly: true }),
			fileSystem,
			packageInfos: [FOO_INFO],
		});

		expect(captured.options).toBeUndefined();
		expect(fileSystem.existsSync(SYNTHESIZED_PROJECT)).toBeFalse();
		expect(result!.typecheckResult).toBeDefined();
		expect(result!.results).toHaveLength(0);
	});

	it("should report results for a type-test-only package rather than erroring on no runtime specs", async () => {
		expect.assertions(2);

		// passWithNoTests defaults false; only a `.spec-d.ts` exists, so runtime
		// discovery finds nothing. The package must not error — its type tests
		// run.
		const { fileSystem } = stageWorkspace(
			{
				...seedSpec(FOO_INFO, "src/foo.spec-d.ts"),
			},
			{
				[FOO_DIR]: rooted(FOO_DIR, {
					testMatch: ["**/*.spec.ts"],
					typecheck: { enabled: true },
				}),
			},
		);

		runTypecheck.mockResolvedValue(makeTypeResult());

		const { backend } = createStubBackend([]);

		const result = await runStagedWorkspaceAsync({
			backend,
			fileSystem,
			packageInfos: [FOO_INFO],
		});

		expect(result).toBeDefined();
		expect(result!.typecheckResult).toBeDefined();
	});
});
