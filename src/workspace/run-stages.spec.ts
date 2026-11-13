import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import type { Except } from "type-fest";
import { assert, describe, expect, it, vi } from "vitest";

import { clockTimingCollector } from "#test/mocks/clock-timing-collector.ts";
import { createLuteChildProcess } from "#test/mocks/lute-child-process.ts";
import type { MemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { movableClockCollector } from "#test/mocks/movable-clock.ts";
import { NOOP_PROGRESS } from "#test/mocks/noop-progress.ts";
import { posixRoot } from "#test/mocks/posix-path.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { writingRojoExec } from "#test/mocks/rojo-exec.ts";
import { MANIFEST_VERSION } from "#test/mocks/run-constants.ts";
import { recordingTimingCollector } from "#test/mocks/workspace-timing-recorder.ts";
import type { Backend } from "../backends/dispatch-request.ts";
import type { BackendResult } from "../backends/interface.ts";
import type { OpenCloudDispatch, OpenCloudSharding } from "../backends/open-cloud-dispatch.ts";
import type { StudioDispatch } from "../backends/plugin-payload.ts";
import type { ProjectEntry } from "../config/config-types.ts";
import type { loadConfig } from "../config/loader.ts";
import type { CliOptions, ResolvedConfig, WorkspaceRunOptions } from "../config/resolved-config.ts";
import type { EnvelopeEntry } from "../protocol/envelope.ts";
import { nodeRunSeams, type RunSeams } from "../run/seams.ts";
import type { WorkspacePackageCoverage } from "../shadow/workspace-prepare.ts";
import type { runTypecheckAsync } from "../typecheck/runner.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PrepareCoverage, WorkspaceProjectResult } from "./coverage-attach.ts";
import type { PackageInfo } from "./package-resolver.ts";
import type { RunWorkspaceOptions } from "./run-stage-types.ts";
import { createWorkspaceRunStages } from "./run-stages.ts";
import type { WorkspaceRunnerOutput } from "./typecheck-pass.ts";

function resolverReturning(
	mapping: Record<string, Array<string>>,
): RunSeams["createSetupResolver"] {
	return (options) => {
		return nodeRunSeams().createSetupResolver({
			...options,
			createResolver: () => {
				return fromAny({
					getRbxPathFromFilePath(filePath: string) {
						return mapping[filePath];
					},
				});
			},
		});
	};
}

const ROOT = path.resolve("/repo");
const WORKSPACE_CACHE = path.join(ROOT, ".jest-roblox", "workspace");
const SYNTHESIZED_PROJECT = path.join(WORKSPACE_CACHE, "synthesized.project.json");
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
}

type PreResolutionConfig = Except<ResolvedConfig, "projects"> & {
	projects?: Array<ProjectEntry> | undefined;
};

function packageJson(json: JSONObject): string {
	return JSON.stringify(json);
}

function passingResult(snapshotWrites?: Record<string, string>): string {
	return JSON.stringify({
		...(snapshotWrites === undefined ? {} : { runner: { snapshotWrites } }),
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
 * What this run dispatched: each job's argv with its package and project, as
 * the materializer payload carries them.
 *
 * @param captured - Holder of the backend options the stub captured.
 * @returns The dispatched entries as JSON.
 */
function dispatchedScript(captured: Partial<Record<"options", OpenCloudDispatch>>): string {
	return JSON.stringify(
		captured.options!.jobs.map((job) => {
			return { config: job.argv, pkg: job.pkg, project: job.displayName };
		}),
	);
}

function stealingOf(
	captured: Partial<Record<"options", OpenCloudDispatch>>,
): Extract<OpenCloudSharding, { kind: "work-stealing" }> {
	const { sharding } = captured.options!;
	if (sharding.kind !== "work-stealing") {
		throw new Error(`Expected a work-stealing dispatch, got ${sharding.kind}`);
	}

	return sharding;
}

function stubJobIndex({
	entry: { pkg, project },
	jobs,
	position,
}: {
	entry: BackendStubEntry;
	jobs: OpenCloudDispatch["jobs"];
	position: number;
}): number {
	if (pkg === undefined) {
		return position;
	}

	return jobs.findIndex((job) => {
		return job.pkg === pkg && (project === undefined || job.displayName === project);
	});
}

function createStubBackend(
	entries: Array<BackendStubEntry>,
	backendOverrides: Partial<BackendResult> = {},
) {
	const captured: Partial<Record<"options", OpenCloudDispatch>> = {};
	const backend: Backend = {
		kind: "open-cloud",
		runTestsAsync: async (options: OpenCloudDispatch): Promise<BackendResult> => {
			captured.options = options;
			return {
				...backendOverrides,
				rawResults: entries.map((entry, position) => {
					const envelope: EnvelopeEntry = { jestOutput: entry.jestOutput };
					if (entry.gameOutput !== undefined) {
						envelope.gameOutput = entry.gameOutput;
					}

					return {
						entry: envelope,
						jobIndex: stubJobIndex({ entry, jobs: options.jobs, position }),
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
		backend: createResolvedConfig().backend,
		bail: false,
		bootProbeTimeout: createResolvedConfig().bootProbeTimeout,
		color: createResolvedConfig().color,
		formatters: [],
		port: createResolvedConfig().port,
		showLuau: createResolvedConfig().showLuau,
		silent: createResolvedConfig().silent,
		timeout: createResolvedConfig().timeout,
		uploadCache: createResolvedConfig().uploadCache,
		verbose: createResolvedConfig().verbose,
		workspaceGameOutput: false,
		workspaceOutputFile: false,
		...overrides,
	};
}

function makeCli(overrides: Partial<CliOptions> = {}): CliOptions {
	return { ...overrides };
}

function timedRojo(fileSystem: FileSystem, onBuild: () => void): ChildProcessRunner {
	return fromAny({ execFile: writingRojoExec({ bytes: PLACE_BYTES, fileSystem, onBuild }) });
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

const loadPackageConfig = vi.fn<typeof loadConfig>(async ({ cwd } = {}) => {
	return createResolvedConfig(cwd === undefined ? {} : { rootDir: cwd });
});

const runTypecheck = vi.fn<typeof runTypecheckAsync>();

type StagedRunOptions = Partial<RunWorkspaceOptions> & { backend?: Backend } & {
	packageInfos: Array<PackageInfo>;
};

/**
 * Drives the stages in the order the run pipeline does, so these specs read
 * the runner output the stages collect.
 * @param options - Run inputs.
 * @param openBackend - Opens the backend for a run with runtime jobs.
 * @returns The runner output, or `undefined` when selection refused the run.
 */
async function runWorkspaceAsync(
	options: RunWorkspaceOptions,
	openBackend: () => Backend,
): Promise<undefined | WorkspaceRunnerOutput> {
	const stages = createWorkspaceRunStages(options);
	const selection = await stages.selectTestsAsync();
	if ("refused" in selection) {
		return undefined;
	}

	if (selection.emptiness?.validationMessage !== undefined) {
		process.stderr.write(selection.emptiness.validationMessage);
		return undefined;
	}

	if (selection.emptiness !== undefined) {
		return { bailedPackages: [], coverageMs: 0, results: [], stagingMs: 0 };
	}

	if (selection.runtimeJobCount === 0) {
		const typecheck = await stages.typecheckAsync(selection);
		return stages.collectOutput({ ...stages.noRuntime(selection), selection, typecheck });
	}

	const backend = openBackend();
	try {
		const staged = await stages.stageAsync(selection);
		const [dispatched, typecheck] = await Promise.all([
			stages.dispatchAsync({ backend, selection, staged }),
			stages.typecheckAsync(selection),
		]);
		return stages.collectOutput({ dispatched, selection, staged, typecheck });
	} finally {
		await backend.closeAsync?.();
	}
}

async function runStagedWorkspaceAsync({
	backend,
	packageInfos,
	...options
}: StagedRunOptions): Promise<undefined | WorkspaceRunnerOutput> {
	const { fileSystem } = options;
	assert(fileSystem !== undefined);
	const childProcess = options.childProcess ?? stubRojo(fileSystem);

	function openBackend(): Backend {
		assert(backend !== undefined, "the run opened a backend it was not given");
		return backend;
	}

	const seams = nodeRunSeams();
	return runWorkspaceAsync(
		{
			childProcess,
			cli: makeCli(),
			createSetupResolver: seams.createSetupResolver,
			cwd: process.cwd(),
			fileSystem,
			prepareCoverage: seams.prepareWorkspaceCoverage,
			progress: NOOP_PROGRESS,
			runOptions: makeRunOptions(),
			runProjects: seams.runProjects,
			runTypecheck,
			timing: clockTimingCollector(),
			tsconfigReader: seams.tsconfigReader,
			workspaceRoot: ROOT,
			...options,
			packages: await Promise.all(
				packageInfos.map(async (info) => {
					const resolved = await loadPackageConfig({ cwd: info.packageDirectory });
					return { config: { declared: {}, resolved }, info };
				}),
			),
		},
		openBackend,
	);
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
		coveragePathIgnorePatterns: [],
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
	return { ...createResolvedConfig(), luauRoots: ["src"], rootDir: rootDirectory, ...overrides };
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
		entries: [passingProjectEntry("@halcyon/foo", "foo")],
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
		entries: [passingProjectEntry("@halcyon/foo", "foo")],
		files: seedSpec(FOO_INFO, "src/foo.spec.luau", "src/Shared/setup.luau"),
		run: {
			createSetupResolver: resolverReturning({
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
		entries: [passingProjectEntry("@halcyon/foo", "foo")],
		files: seedSpec(FOO_INFO, ...specFiles),
		run: { packageInfos: [FOO_INFO] },
	});
	return runTypecheck.mock.calls[0]![0].files;
}

describe(createWorkspaceRunStages, () => {
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

		const memory = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
			[FOO_DIR]: rooted(FOO_DIR),
		});
		const stub = createStubBackend(passingEntries("@halcyon/foo"));
		let captured: StudioDispatch | undefined;
		const backend: Backend = {
			kind: "studio",
			runTestsAsync: async (options: StudioDispatch) => {
				captured = options;
				return stub.backend.runTestsAsync(fromAny(options));
			},
		};
		await runStagedWorkspaceAsync({
			backend,
			fileSystem: memory.fileSystem,
			packageInfos: [FOO_INFO],
			runOptions: makeRunOptions({ experimentalVmParallel: 3 }),
		});

		expect(captured!.vmParallel).toBe(3);
	});

	it("should hand the backend run settings from the workspace, not the first package", async () => {
		expect.assertions(1);

		const memory = stageWorkspace(
			{
				...seedSpec(FOO_INFO, "src/foo.spec.luau"),
				...seedSpec(BAR_INFO, "src/bar.spec.luau"),
			},
			{
				[BAR_DIR]: rooted(BAR_DIR, { timeout: 9000 }),
				[FOO_DIR]: rooted(FOO_DIR, {
					bootProbeTimeout: 1,
					timeout: 1000,
					uploadCache: true,
				}),
			},
		);
		const stub = createStubBackend(passingEntries("@halcyon/foo", "@halcyon/bar"));
		await runStagedWorkspaceAsync({
			backend: stub.backend,
			fileSystem: memory.fileSystem,
			packageInfos: [FOO_INFO, BAR_INFO],
			runOptions: makeRunOptions({ bootProbeTimeout: 7, timeout: 9000, uploadCache: false }),
		});

		expect(stub.captured.options!.runSettings).toMatchObject({
			bootProbeTimeout: 7,
			rootDir: ROOT,
			timeout: 9000,
			uploadCache: false,
		});
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

	it("should fail a run whose testPathPattern matches no test in any package", async () => {
		expect.assertions(2);

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const { results } = await runLuauFooAsync(
			seedSpec(FOO_INFO, "src/foo.spec.luau"),
			makeCli({ testPathPattern: "src/other-package.spec" }),
		);

		expect(results).toBeUndefined();
		expect(stderr).toHaveBeenCalledWith("No test files found in any project\n");
	});

	// Regression: a positional file was discarded in workspace mode, so
	// `--workspace path/to/one.spec.ts` staged every package and ran the whole
	// workspace while reporting nothing about the argument it dropped.
	it("should dispatch only the package a positional file names", async () => {
		expect.assertions(3);

		const { captured, fileSystem } = await runScenarioAsync({
			configs: luauConfigs(BAR_DIR, FOO_DIR),
			entries: [passingProjectEntry("@halcyon/foo", "foo")],
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
			entries: [passingProjectEntry("@halcyon/foo", "foo")],
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
	// same translation `--testPathPattern` does. A namesake in a sibling
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

	it("should synthesize one implicit project named after the package folder when projects: is absent", async () => {
		expect.assertions(2);

		const { captured, results } = await runScenarioAsync({
			configs: {
				[FOO_DIR]: rooted(FOO_DIR),
			},
			entries: [passingProjectEntry("@halcyon/foo", "foo")],
			files: seedSpec(FOO_INFO, "src/foo.spec.luau"),
			run: {
				packageInfos: [FOO_INFO],
			},
		});

		expect(dispatchedScript(captured)).toContain('"project":"foo"');
		expect(results![0]!.displayName).toBe("foo");
	});

	it("should open every host phase", async () => {
		expect.assertions(2);

		const { fileSystem } = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
			[FOO_DIR]: rooted(FOO_DIR),
		});

		const { backend } = createStubBackend([passingProjectEntry("@halcyon/foo", "foo")]);

		const { collector, paths } = recordingTimingCollector();
		await runStagedWorkspaceAsync({
			backend,
			fileSystem,
			packageInfos: [FOO_INFO],
			timing: collector,
		});

		expect(paths).toStrictEqual(
			expect.arrayContaining([
				"resolveContexts",
				"discoverTests",
				"generateProjectStubs",
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

		const { backend } = createStubBackend([passingProjectEntry("@halcyon/foo", "foo")]);

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

		expect(paths).toContain("resolveContexts");
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

		expect(captured.options!.jobs[0].testFiles).toStrictEqual(["src/a.spec.luau"]);
	});

	it("should drop runtime test files matching a package-level test.exclude glob", async () => {
		expect.assertions(1);

		// No `projects:`, so the package's global `test.exclude` must flow into
		// the synthesized virtual project, mirroring single-mode `test.exclude`.
		const { captured } = await runScenarioAsync({
			configs: {
				[FOO_DIR]: rooted(FOO_DIR, {
					exclude: ["**/*.gen.spec.luau"],
				}),
			},
			entries: [passingProjectEntry("@halcyon/foo", "foo")],
			files: seedSpec(FOO_INFO, "src/a.gen.spec.luau", "src/a.spec.luau"),
			run: {
				packageInfos: [FOO_INFO],
			},
		});

		expect(captured.options!.jobs[0].testFiles).toStrictEqual(["src/a.spec.luau"]);
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

		const createSetupResolver = vi.fn<RunSeams["createSetupResolver"]>();

		const { backend } = createStubBackend([passingProjectEntry("@halcyon/foo", "foo")]);

		await runStagedWorkspaceAsync({
			backend,
			createSetupResolver,
			fileSystem,
			packageInfos: [FOO_INFO],
		});

		// No project declares setupFiles/setupFilesAfterEnv, so the costly
		// RojoResolver tree walk must be skipped entirely; it is the dominant
		// resolveContexts cost and resolves nothing here.
		expect(createSetupResolver).not.toHaveBeenCalled();
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
				// Bar has ONLY custom.project.json; no test.project.json on
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
			passingProjectEntry("@halcyon/foo", "foo"),
			passingProjectEntry("@halcyon/bar", "bar"),
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

		// Bar's per-pkg config has no rojoProject. Previously the middle
		// arm of `pkg ?? config ?? DEFAULT` would pick up the workspace-root
		// value below and resolve "custom.project.json". After the collapse,
		// resolution falls straight to `ROJO_PROJECT_DEFAULT`
		// ("test.project.json"), which does not exist at BAR_DIR, so preflight
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
			entries: [passingProjectEntry("@halcyon/foo", "foo")],
			files: {
				...seedSpec(FOO_INFO, "src/a.spec.luau", "src/b.spec.luau"),
				...seedPackage(BAR_DIR, {
					name: "@halcyon/bar",
					extras: { [path.join(BAR_DIR, "src/init.luau")]: "return {}" },
				}),
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
			...seedPackage(BAR_DIR, {
				name: "@halcyon/bar",
				extras: { [path.join(BAR_DIR, "src/init.luau")]: "return {}" },
			}),
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
				passingProjectEntry("@halcyon/foo", "foo"),
				{
					jestOutput: failingResult(),
					pkg: "@halcyon/bar",
					project: "bar",
				},
				passingProjectEntry("@halcyon/baz", "baz"),
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
		expect(results![0]!.displayName).toBe("foo");
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
				// extension and no children; should NOT be created as a
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
				[FOO_DIR]: rooted(FOO_DIR, { luauRoots: ["src/has.dot"] }),
			},
			entries: [passingProjectEntry("@halcyon/foo", "foo")],
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
		it("should embed runnerCoverage in the materializer config when collectCoverage is set", async () => {
			expect.assertions(1);

			const { fileSystem } = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
				[FOO_DIR]: rooted(FOO_DIR, {
					collectCoverage: true,
				}),
			});

			const prepareCoverage = vi.fn<PrepareCoverage>(() => [
				{
					coveragePathIgnorePatterns: [],
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
					coveragePathIgnorePatterns: [],
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
		async function runStealingFooAsync(run: Partial<StagedRunOptions>) {
			return runScenarioAsync({
				configs: { [FOO_DIR]: rooted(FOO_DIR) },
				entries: passingEntries("@halcyon/foo"),
				files: seedSpec(FOO_INFO, "src/foo.spec.luau"),
				run: { packageInfos: [FOO_INFO], ...run },
			});
		}

		it("should ask an Open Cloud backend to work-steal when parallel>1", async () => {
			expect.assertions(3);

			const { captured } = await runStealingFooAsync({
				runOptions: makeRunOptions({ bail: true, parallel: 2 }),
			});

			expect(stealingOf(captured).parallel).toBe(2);
			expect(stealingOf(captured).bail).toBeTrue();
			expect(stealingOf(captured).onPackageResult).toBeUndefined();
		});

		it("should shard on parallel auto rather than falling back to one task", async () => {
			expect.assertions(1);

			const { captured } = await runStealingFooAsync({
				runOptions: makeRunOptions({ parallel: "auto" }),
			});

			expect(stealingOf(captured).parallel).toBe("auto");
		});

		it("should keep the deferrable path when parallel is unset", async () => {
			expect.assertions(1);

			const { captured } = await runStealingFooAsync({ runOptions: makeRunOptions() });

			expect(captured.options!.sharding.kind).toBe("deferrable");
		});

		it("should route each streamed entry once through the supplied onStreamingResult", async () => {
			expect.assertions(1);

			const seen: Array<string> = [];
			const streamedEntry = {
				elapsedMs: 5,
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				pkg: "@halcyon/foo",
				project: "foo",
				success: true,
			};
			const { fileSystem } = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
				[FOO_DIR]: rooted(FOO_DIR),
			});
			const { backend } = createStubBackend(passingEntries("@halcyon/foo"));
			const wrappedBackend: Backend = {
				kind: "open-cloud",
				runTestsAsync: async (options: OpenCloudDispatch) => {
					const { onPackageResult } = stealingOf({ options });
					onPackageResult!(streamedEntry);
					onPackageResult!(streamedEntry);
					return backend.runTestsAsync(options);
				},
			};

			await runStagedWorkspaceAsync({
				backend: wrappedBackend,
				cli: makeCli(),
				fileSystem,
				onStreamingResult: (entry) => {
					seen.push(entry.pkg);
				},
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ parallel: 2 }),
				workspaceRoot: ROOT,
			});

			expect(seen).toStrictEqual(["@halcyon/foo"]);
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
			const { backend } = createStubBackend(
				[{ jestOutput: passingResult(), pkg: "@halcyon/bar" }],
				{ bailed: true },
			);

			const output = await runStagedWorkspaceAsync({
				backend,
				cli: makeCli(),
				fileSystem,
				packageInfos: [FOO_INFO, BAR_INFO],
				runOptions: makeRunOptions({ bail: true, parallel: 2 }),
				workspaceRoot: ROOT,
			});

			expect(output!.results).toHaveLength(1);
			expect(output!.results[0]!.pkg).toBe("@halcyon/bar");
			expect(output!.bailedPackages).toStrictEqual(["@halcyon/foo"]);
		});

		// A package with several projects is one package. When a bail stops it
		// part-way, the package RAN. Naming it as not-run too would report the
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
			const { backend } = createStubBackend([passingProjectEntry("@halcyon/foo", "client")], {
				bailed: true,
			});

			const output = await runStagedWorkspaceAsync({
				backend,
				cli: makeCli(),
				fileSystem,
				packageInfos: [FOO_INFO],
				runOptions: makeRunOptions({ bail: true, parallel: 2 }),
				workspaceRoot: ROOT,
			});

			expect(output!.results).toHaveLength(1);
			expect(output!.bailedPackages).toBeEmpty();
		});
	});

	describe("type test units", () => {
		it("should file the package's Type Test result under its type-test project", async () => {
			expect.assertions(1);

			const { fileSystem } = stagePassingTypecheckFoo();
			const { backend } = createStubBackend([]);

			const output = await runStagedWorkspaceAsync({
				backend,
				cli: makeCli({ typecheckOnly: true }),
				fileSystem,
				packageInfos: [FOO_INFO],
			});

			expect(output!.typecheckUnits).toStrictEqual([
				{
					pkg: "@halcyon/foo",
					project: "foo",
					result: expect.objectContaining({
						testResults: [
							expect.objectContaining({
								testFilePath: "@halcyon/foo/src/foo.spec-d.ts",
							}),
						],
					}),
				},
			]);
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
						jestOutput: passingResult({
							"ReplicatedStorage/Pkg/__snapshots__/foo.spec.snap.luau":
								"foo-snap-content",
						}),
						pkg: "@halcyon/foo",
					},
					{
						jestOutput: passingResult({
							"ReplicatedStorage/Pkg/__snapshots__/bar.spec.snap.luau":
								"bar-snap-content",
						}),
						pkg: "@halcyon/bar",
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

		it("should still write sibling snapshots and collect every result when one entry's envelope is a failure", async () => {
			expect.assertions(3);

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
					jestOutput: passingResult({
						"ReplicatedStorage/Pkg/__snapshots__/bar.spec.snap.luau":
							"bar-snap-content",
					}),
					pkg: "@halcyon/bar",
				},
			]);

			const output = await runStagedWorkspaceAsync({
				backend,
				fileSystem,
				packageInfos: [FOO_INFO, BAR_INFO],
				runOptions: makeRunOptions({ silent: true }),
			});

			// bar's snapshot lands even though foo's envelope failed.
			expect(
				volume.readFileSync(
					path.join(BAR_DIR, "src/__snapshots__/bar.spec.snap.luau"),
					"utf8",
				),
			).toBe("bar-snap-content");

			// Both results reach the output layer: foo's documents the
			// failure, bar's the pass.
			expect(
				output!.results.find((entry) => entry.pkg === "@halcyon/foo")!.result.result,
			).toMatchObject({ success: false });
			expect(
				output!.results.find((entry) => entry.pkg === "@halcyon/bar")!.result.result,
			).toMatchObject({ numPassedTests: 1, success: true });
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
	it("should check default type patterns when enabled and keep them out of Roblox Jest", async () => {
		expect.assertions(2);

		runTypecheck.mockResolvedValue(makeTypeResult());
		const { captured } = await runScenarioAsync({
			configs: { [FOO_DIR]: rooted(FOO_DIR) },
			entries: [passingProjectEntry("@halcyon/foo", "foo")],
			files: seedSpec(FOO_INFO, "src/foo.spec-d.ts", "src/foo.spec.ts"),
			run: { cli: makeCli({ typecheck: true }), packageInfos: [FOO_INFO] },
		});

		expect(runTypecheck).toHaveBeenCalledWith(
			expect.objectContaining({
				files: expect.arrayContaining([expect.stringMatching(/foo\.spec-d\.ts$/)]),
			}),
		);
		expect(dispatchedScript(captured)).toContain('"testMatch":["**/*.spec","**/*.test"]');
	});

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

		const { backend } = createStubBackend([passingProjectEntry("@halcyon/foo", "foo")]);

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

		const { backend } = createStubBackend([passingProjectEntry("@halcyon/foo", "foo")]);

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

		// Absolute and platform-native, the same shape the glob half produces:
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
			entries: [passingProjectEntry("@halcyon/foo", "foo")],
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
			passingProjectEntry("@halcyon/foo", "foo"),
			passingProjectEntry("@halcyon/bar", "bar"),
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
			passingProjectEntry("@halcyon/foo", "foo"),
			passingProjectEntry("@halcyon/bar", "bar"),
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
			runTestsAsync: async (): Promise<BackendResult> => {
				signalRuntimeStarted();
				await typecheckStarted;
				return {
					rawResults: [
						{
							entry: { jestOutput: passingResult() },
							jobIndex: 0,
						},
					],
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
			passingProjectEntry("@halcyon/foo", "foo"),
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

	it("should open no backend when every project is type-only through its config", async () => {
		expect.assertions(2);

		const { fileSystem } = stageWorkspace(
			seedSpec(FOO_INFO, "src/foo.spec-d.ts", "src/foo.spec.ts"),
			{
				[FOO_DIR]: rooted(FOO_DIR, {
					testMatch: ["**/*.spec.ts"],
					typecheck: { enabled: true, only: true },
				}),
			},
		);
		runTypecheck.mockResolvedValue(makeTypeResult());

		const result = await runStagedWorkspaceAsync({ fileSystem, packageInfos: [FOO_INFO] });

		expect(result!.results).toStrictEqual([]);
		expect(result!.typecheckResult).toBeDefined();
	});

	it("should close the backend it opened when the dispatch fails", async () => {
		expect.assertions(2);

		const { fileSystem } = stageWorkspace(seedSpec(FOO_INFO, "src/foo.spec.luau"), {
			[FOO_DIR]: rooted(FOO_DIR, { testMatch: ["**/*.spec.luau"] }),
		});
		const { backend } = createStubBackend([]);
		const closeAsync = vi.fn<() => Promise<void>>(async () => {});
		const failing: Backend = {
			...backend,
			closeAsync,
			runTestsAsync: async () => {
				throw new Error("dispatch failed");
			},
		};

		await expect(
			runStagedWorkspaceAsync({ backend: failing, fileSystem, packageInfos: [FOO_INFO] }),
		).rejects.toThrow("dispatch failed");
		expect(closeAsync).toHaveBeenCalledOnce();
	});

	it("should report results for a type-test-only package rather than erroring on no runtime specs", async () => {
		expect.assertions(2);

		// passWithNoTests defaults false; only a `.spec-d.ts` exists, so runtime
		// discovery finds nothing. The package must not error; its type tests
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
