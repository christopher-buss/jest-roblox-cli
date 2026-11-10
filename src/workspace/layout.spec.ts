import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import type { Except } from "type-fest";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { fakeTimingCollector } from "#test/mocks/fake-timing-collector.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { NOOP_PROGRESS } from "#test/mocks/noop-progress.ts";
import { fakeBackendOfKind } from "#test/mocks/place-input.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { MANIFEST_VERSION } from "#test/mocks/run-constants.ts";
import { createRunSeams } from "#test/mocks/run-seams.ts";
import type { Backend } from "../backends/dispatch-request.ts";
import type { BackendResult, DispatchBase } from "../backends/interface.ts";
import type { Config } from "../config/config-types.ts";
import type { CliOptions, ResolvedConfig } from "../config/resolved-config.ts";
import type { CoverageMapper } from "../coverage-report/mapper.ts";
import type { ExecuteResult } from "../executor/executor-types.ts";
import type { CoverageUnitSettings } from "../results/coverage-unit.ts";
import { runPipelineAsync } from "../run/pipeline.ts";
import type { RunSeams } from "../run/seams.ts";
import { nodeRunSeams } from "../run/seams.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { WorkspaceProjectResult } from "./coverage-attach.ts";
import type { WorkspaceLayoutInput } from "./layout.ts";
import { createWorkspaceLayout } from "./layout.ts";
import type { RunWorkspaceOptions } from "./run-stage-types.ts";
import type { createWorkspaceRunStages, WorkspaceRunStages } from "./run-stages.ts";
import type { WorkspaceRunnerOutput } from "./typecheck-pass.ts";

const ROOT = path.resolve("/repo");
const CONFIG_ROOT = path.resolve("/ws");

/**
 * Every package name the specs below select, as the resolver would report.
 */
const WORKSPACE_PACKAGES = ["@halcyon/bar", "@halcyon/foo", "a", "foo"];

const CREDENTIAL_SUFFIXES = ["OPEN_CLOUD_API_KEY", "PLACE_ID", "UNIVERSE_ID"];

function packageDirectoryFor(root: string, name: string): string {
	return path.join(root, "packages", name.replace("@", "").replace("/", "-"));
}

function seedWorkspace(root: string, names: Array<string>): Record<string, string> {
	const entries: Record<string, string> = {
		[path.join(root, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
	};
	for (const name of names) {
		const directory = packageDirectoryFor(root, name);
		entries[path.join(directory, "package.json")] = `{"name":${JSON.stringify(name)}}`;
		entries[path.join(directory, "jest.config.ts")] = "export default {};";
	}

	return entries;
}

function seedTurboWorkspace(root: string, names: Array<string>): Record<string, string> {
	return { [path.join(root, "turbo.json")]: "{}", ...seedWorkspace(root, names) };
}

function stubLinux(): void {
	const original = process.platform;
	Object.defineProperty(process, "platform", { value: "linux" });
	onTestFinished(() => {
		Object.defineProperty(process, "platform", { value: original });
	});
}

function createRunner(): ChildProcessRunner {
	return fromAny({ execFileSync: vi.fn<ChildProcessRunner["execFileSync"]>() });
}

function turboReturns({
	childProcess,
	names,
	root,
}: {
	childProcess: ChildProcessRunner;
	names: Array<string>;
	root: string;
}): void {
	vi.mocked(childProcess.execFileSync).mockReturnValue(
		JSON.stringify({
			packages: {
				items: names.map((name) => {
					return {
						name,
						path: path.relative(root, packageDirectoryFor(root, name)),
					};
				}),
			},
		}),
	);
}

function stubCredentials(): void {
	for (const suffix of CREDENTIAL_SUFFIXES) {
		vi.stubEnv(`JEST_ROBLOX_${suffix}`, `test-${suffix}`);
		vi.stubEnv(`ROBLOX_${suffix}`, "");
	}

	vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_BASE_URL", "");
}

function makeCli(overrides: Partial<CliOptions> = {}): CliOptions {
	// The fallback formatter list is env-probed through `std-env`, which
	// resolves once when it loads.
	return { backend: "open-cloud", formatters: ["default"], ...overrides };
}

function makeJestResult(overrides: Partial<JestResult> = {}): JestResult {
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

function coverageSettingsStub(): CoverageUnitSettings {
	return {
		coverageDirectory: "/ws/packages/foo/coverage",
		coverageReporters: ["text", "lcov"],
		rootDir: "/ws/packages/foo",
	};
}

function makeExecuteResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
	return {
		exitCode: 0,
		result: makeJestResult(),
		timing: {
			executionMs: 0,
			startTime: 0,
			testsMs: 0,
			totalMs: 0,
			uploadMs: 0,
		},
		...overrides,
	};
}

function makeFakeBackend(kind: Backend["kind"] = "open-cloud"): Backend {
	return fakeBackendOfKind(kind, {
		closeAsync: vi.fn<() => void>(),
		runTestsAsync: vi.fn<(options: DispatchBase) => Promise<BackendResult>>(async () => {
			return { rawResults: [], timing: { executionMs: 0 } };
		}),
	});
}

function toStdoutText(chunk: Parameters<typeof process.stdout.write>[0]): string {
	return typeof chunk === "string" ? chunk : String(chunk);
}

/**
 * Per-package `color`, disagreeing across packages to trip consensus.
 *
 * @param cwd - Package directory the config loads from.
 * @returns A `color` that is `true` only for the `foo` package.
 */
function colorForPackageDirectory(cwd: string | undefined) {
	return { color: cwd!.endsWith("foo") };
}

const MANIFEST = {
	buildId: "test-build-id",
	files: {},
	generatedAt: "x",
	instrumenterVersion: 2,
	luauRoots: [],
	nonInstrumentedFiles: {},
	shadowDir: "/shadow",
	version: MANIFEST_VERSION,
};

type FakeRunner = (
	options: RunWorkspaceOptions & { openBackend: () => void },
) => Promise<undefined | WorkspaceRunnerOutput>;

interface HarnessDependencies extends Partial<RunSeams> {
	createRunStages: NonNullable<WorkspaceLayoutInput["createRunStages"]>;
	fileSystem: WorkspaceLayoutInput["fileSystem"];
	isStudioInstalled?: () => boolean;
}

type Harness = ReturnType<typeof setupHappyPath>;

interface SinglePackageRun {
	name: string;
	cli?: Partial<CliOptions>;
	workspace?: WorkspaceLayoutInput["workspace"];
}

/**
 * Stages that replay one runner output. The run has runtime jobs exactly when
 * the runner asked for a backend, and dispatch records the backend the
 * pipeline opened.
 * @param options - Options the layout built the stages with.
 * @param fake - Fake runner to replay, and the list each opened backend joins.
 * @returns Stages that replay the runner output.
 */
function fakeStages(
	options: RunWorkspaceOptions,
	{ opened, runner }: { opened: Array<Backend>; runner: FakeRunner },
): WorkspaceRunStages {
	let output: WorkspaceRunnerOutput = {
		bailedPackages: [],
		coverageMs: 0,
		results: [],
		stagingMs: 0,
	};
	return {
		collectOutput: () => output,
		dispatchAsync: async (input) => {
			opened.push(input.backend);
			return { results: [] };
		},
		noRuntime: () => fromAny({}),
		selectTestsAsync: async () => {
			const asked = { backend: false };
			const replayed = await runner({
				...options,
				openBackend: () => {
					asked.backend = true;
				},
			});
			if (replayed === undefined) {
				return {
					refused: {
						coverageMs: 0,
						projectResults: [],
						stagingMs: 0,
						validationExitCode: 2,
					},
				};
			}

			output = replayed;
			const hasNothing =
				!asked.backend &&
				replayed.results.length === 0 &&
				replayed.typecheckResult === undefined;
			return fromAny({
				emptiness: hasNothing ? {} : undefined,
				runtimeJobCount: asked.backend ? 1 : 0,
				selection: { affected: undefined, changedFiles: undefined },
			});
		},
		stageAsync: async () => fromAny({}),
		typecheckAsync: async () => {
			return {
				byPackage: new Map(),
				outcome: { elapsedMs: 0, result: output.typecheckResult },
			};
		},
	};
}

function resolveDeclared({ test, ...rest }: Config): ResolvedConfig {
	return createResolvedConfig(fromAny({ ...rest, ...test }));
}

function setupHappyPath(seed: Record<string, string> = seedWorkspace(ROOT, WORKSPACE_PACKAGES)) {
	vi.spyOn(process, "cwd").mockReturnValue(ROOT);
	stubCredentials();

	const backend = makeFakeBackend();
	const { fileSystem } = createMemoryFileSystem(seed, ROOT);
	const childProcess = createRunner();
	const mapCoverage = vi.fn<CoverageMapper>(() => ({ files: {} }));
	const loadPackageConfig = vi.fn<(request: { cwd?: string | undefined }) => Promise<Config>>(
		async () => ({}),
	);
	const openBackendFake = vi.fn<RunSeams["openBackend"]>((request) => {
		const { kind } = nodeRunSeams().openBackend(request);
		return kind === "open-cloud" ? backend : makeFakeBackend(kind);
	});
	const opened: Array<Backend> = [];
	const runWorkspace = vi.fn<FakeRunner>(async (options) => {
		options.openBackend();
		return { bailedPackages: [], coverageMs: 0, results: [], stagingMs: 0 };
	});
	const createRunStages = vi.fn<typeof createWorkspaceRunStages>((options) => {
		return fakeStages(options, { opened, runner: runWorkspace });
	});

	const dependencies: HarnessDependencies = {
		childProcess,
		createRunStages,
		fileSystem,
		loadPackageConfig: async (request) => {
			const declared = await loadPackageConfig(request);
			return {
				declared,
				resolved: resolveDeclared({ rootDir: request.cwd ?? ROOT, ...declared }),
			};
		},
		mapCoverage,
		openBackend: openBackendFake,
	};

	return {
		backend,
		childProcess,
		createRunStages,
		dependencies,
		fileSystem,
		loadPackageConfig,
		openBackend: openBackendFake,
		opened,
		runWorkspace,
	};
}

async function runWorkspaceModeAsync({
	dependencies: { createRunStages, fileSystem, isStudioInstalled = () => false, ...seams },
	progress = NOOP_PROGRESS,
	timing = fakeTimingCollector(),
	...input
}: Except<
	WorkspaceLayoutInput,
	"createRunStages" | "fileSystem" | "progress" | "seams" | "timing"
> &
	Partial<Pick<WorkspaceLayoutInput, "progress" | "timing">> & {
		dependencies: HarnessDependencies;
	}) {
	return runPipelineAsync(
		createWorkspaceLayout({
			...input,
			createRunStages,
			fileSystem,
			progress,
			seams: createRunSeams({
				...seams,
				openBackend: (request) => {
					return (seams.openBackend ?? nodeRunSeams().openBackend)({
						...request,
						isStudioInstalled,
					});
				},
			}),
			timing,
		}),
		{ progress, timing },
	);
}

function runWorkspaceReturns({
	results,
	runWorkspace,
	typecheckResult,
}: Harness & { results: Array<WorkspaceProjectResult>; typecheckResult?: JestResult }): void {
	runWorkspace.mockImplementation(async (options) => {
		options.openBackend();
		return { bailedPackages: [], coverageMs: 0, results, stagingMs: 0, typecheckResult };
	});
}

async function runSinglePackageAsync(
	harness: Harness,
	{ name, cli = {}, workspace }: SinglePackageRun,
): ReturnType<typeof runPipelineAsync> {
	runWorkspaceReturns({
		...harness,
		results: [{ displayName: name, pkg: name, result: makeExecuteResult() }],
	});
	return runWorkspaceModeAsync({
		cli: makeCli({ ...cli, workspace: true }),
		dependencies: harness.dependencies,
		...(workspace === undefined ? {} : { workspace }),
	});
}

function runnerCall({ createRunStages }: Harness): RunWorkspaceOptions {
	return createRunStages.mock.calls[0]![0];
}

function openedBackend({ opened }: Harness): Backend {
	return opened[0]!;
}

function backendSettings({ openBackend: open, opened }: Harness): Record<string, unknown> {
	const { cli, config } = open.mock.calls[0]![0];
	const { kind } = opened[0]!;
	if (kind === "studio") {
		return { kind, port: config.port, timeout: config.timeout };
	}

	return {
		headed: cli.headed,
		hiddenDesktop: config.hiddenDesktop,
		kind,
		pluginsDirectory: config.pluginsDirectory,
		studioPath: config.studioPath,
		timeout: config.timeout,
	};
}

function packageNames(harness: Harness): Array<string> {
	return runnerCall(harness).packages.map(({ info }) => info.name);
}

describe(createWorkspaceLayout, () => {
	describe("validation", () => {
		it("should surface mutually-exclusive --packages/--affected-since failure", async () => {
			expect.assertions(2);

			const { dependencies } = setupHappyPath();
			const result = await runWorkspaceModeAsync({
				cli: makeCli({ affectedSince: "main", packages: "a", workspace: true }),
				dependencies,
			});

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain(
				"--packages and --affected-since are mutually exclusive",
			);
		});

		it("should run every enumerated package for a bare --workspace", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			const result = await runSinglePackageAsync(harness, { name: "a" });

			expect(result.validationExitCode).toBeUndefined();
			expect(packageNames(harness)).toIncludeSameMembers(WORKSPACE_PACKAGES);
		});

		it("should reject a bare --workspace that enumerates nothing", async () => {
			expect.assertions(3);

			const { dependencies } = setupHappyPath(seedWorkspace(ROOT, []));

			const result = await runWorkspaceModeAsync({
				cli: makeCli({ workspace: true }),
				dependencies,
			});

			// Distinct from --affected-since finding nothing: a workspace with
			// no testable package in it is a misconfiguration, not a clean run.
			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain("no packages with a jest.config.*");
			expect(result.validationMessage).toContain("Widen pnpm-workspace.yaml");
		});

		// The remedy differs by source: a `workspace.packages` list is the
		// user's own glob, so pointing at pnpm-workspace.yaml would misdirect.
		it("should name workspace.packages when the config glob enumerates nothing", async () => {
			expect.assertions(1);

			const { dependencies } = setupHappyPath(seedWorkspace(CONFIG_ROOT, []));

			const result = await runWorkspaceModeAsync({
				cli: makeCli({ workspace: true }),
				dependencies,
				workspace: { packages: ["packages/*"], root: CONFIG_ROOT },
			});

			expect(result.validationMessage).toContain("Widen `workspace.packages`");
		});

		it("should accept studio-cli with --parallel > 1", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			runWorkspaceReturns({
				...harness,
				results: [{ displayName: "a", pkg: "a", result: makeExecuteResult() }],
			});
			const result = await runWorkspaceModeAsync({
				cli: makeCli({
					backend: "studio-cli",
					packages: "a",
					parallel: 2,
					workspace: true,
				}),
				dependencies: harness.dependencies,
			});

			expect(result.validationExitCode).toBeUndefined();
		});

		it("should accept studio-cli with --parallel auto", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			runWorkspaceReturns({
				...harness,
				results: [{ displayName: "a", pkg: "a", result: makeExecuteResult() }],
			});
			const result = await runWorkspaceModeAsync({
				cli: makeCli({
					backend: "studio-cli",
					packages: "a",
					parallel: "auto",
					workspace: true,
				}),
				dependencies: harness.dependencies,
			});

			expect(result.validationExitCode).toBeUndefined();
		});

		// The reported failure: `parallel` comes from the package config, not
		// from a flag the user can drop for the run.
		it('should accept studio-cli when a package config declares parallel "auto"', async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			harness.loadPackageConfig.mockResolvedValue({ parallel: "auto" });
			const result = await runSinglePackageAsync(harness, {
				name: "a",
				cli: {
					backend: "studio-cli",
					packages: "a",
				},
			});

			expect(result.validationExitCode).toBeUndefined();
		});
	});

	describe("backend resolution", () => {
		it("should reject --experimental-vm-parallel on open-cloud", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();

			await expect(
				runWorkspaceModeAsync({
					cli: makeCli({
						experimentalVmParallel: "auto",
						packages: "a",
						workspace: true,
					}),
					dependencies: harness.dependencies,
				}),
			).rejects.toThrow("--experimental-vm-parallel is Studio-only");
		});

		it("should forward --experimental-vm-parallel to a studio-cli workspace run", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();

			await runWorkspaceModeAsync({
				cli: makeCli({
					backend: "studio-cli",
					experimentalVmParallel: "auto",
					packages: "a",
					workspace: true,
				}),
				dependencies: harness.dependencies,
			});

			expect(runnerCall(harness).runOptions.experimentalVmParallel).toBe("auto");
		});

		it("should resolve auto to studio-cli when Studio is installed", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			vi.spyOn(process.stderr, "write").mockReturnValue(true);
			runWorkspaceReturns({
				...harness,
				results: [{ displayName: "a", pkg: "a", result: makeExecuteResult() }],
			});

			await runWorkspaceModeAsync({
				cli: makeCli({ backend: "auto", packages: "a", workspace: true }),
				dependencies: { ...harness.dependencies, isStudioInstalled: () => true },
			});

			expect(backendSettings(harness)).toStrictEqual({
				headed: undefined,
				hiddenDesktop: undefined,
				kind: "studio-cli",
				pluginsDirectory: undefined,
				studioPath: undefined,
				timeout: createResolvedConfig().timeout,
			});
			expect(harness.openBackend).toHaveBeenCalledOnce();
		});

		it("should run --bail on studio-cli when auto resolves to it", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();

			const result = await runWorkspaceModeAsync({
				cli: makeCli({ backend: "auto", bail: true, packages: "a", workspace: true }),
				dependencies: { ...harness.dependencies, isStudioInstalled: () => true },
			});

			expect(result.validationExitCode).toBeUndefined();
			expect(backendSettings(harness)).toStrictEqual({
				headed: undefined,
				hiddenDesktop: undefined,
				kind: "studio-cli",
				pluginsDirectory: undefined,
				studioPath: undefined,
				timeout: createResolvedConfig().timeout,
			});
		});

		it("should resolve the studio-cli backend without Open Cloud credentials", async () => {
			expect.assertions(3);

			const harness = setupHappyPath();
			await runSinglePackageAsync(harness, {
				name: "a",
				cli: { backend: "studio-cli", packages: "a" },
			});

			expect(backendSettings(harness)).toStrictEqual({
				headed: undefined,
				hiddenDesktop: undefined,
				kind: "studio-cli",
				pluginsDirectory: undefined,
				studioPath: undefined,
				timeout: createResolvedConfig().timeout,
			});
			expect(harness.openBackend).toHaveBeenCalledOnce();
			expect(openedBackend(harness).kind).toBe("studio-cli");
		});

		it("should forward the resolved studioPath to the studio-cli backend", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			harness.loadPackageConfig.mockResolvedValue({ studioPath: "C:/s.exe" });
			await runSinglePackageAsync(harness, {
				name: "a",
				cli: { backend: "studio-cli", packages: "a" },
			});

			expect(backendSettings(harness)).toMatchObject({ studioPath: "C:/s.exe" });
		});

		it("should forward the resolved pluginsDirectory to the studio-cli backend", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			harness.loadPackageConfig.mockResolvedValue({ pluginsDirectory: "/plugins" });
			await runSinglePackageAsync(harness, {
				name: "a",
				cli: { backend: "studio-cli", packages: "a" },
			});

			expect(backendSettings(harness)).toMatchObject({ pluginsDirectory: "/plugins" });
		});

		it("should pass the configured timeout to the studio-cli backend", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			harness.loadPackageConfig.mockResolvedValue({ timeout: 1234 });
			await runSinglePackageAsync(harness, {
				name: "a",
				cli: { backend: "studio-cli", packages: "a" },
			});

			expect(backendSettings(harness)).toMatchObject({ timeout: 1234 });
		});

		it("should pass the configured timeout to the attached studio backend", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			harness.loadPackageConfig.mockResolvedValue({ timeout: 1234 });
			await runSinglePackageAsync(harness, {
				name: "a",
				cli: { backend: "studio", packages: "a" },
			});

			expect(backendSettings(harness)).toMatchObject({ timeout: 1234 });
		});

		it("should give the backend the longest package timeout", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			harness.loadPackageConfig
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({ timeout: 900_000 });
			await runSinglePackageAsync(harness, {
				name: "a",
				cli: { backend: "studio-cli", packages: "a,foo" },
			});

			expect(backendSettings(harness)).toMatchObject({ timeout: 900_000 });
		});

		it("should build the studio-cli backend on the run's file system", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			await runSinglePackageAsync(harness, {
				name: "a",
				cli: { backend: "studio-cli", packages: "a" },
			});

			expect(harness.openBackend).toHaveBeenCalledWith(
				expect.objectContaining({ fileSystem: harness.fileSystem, workspace: true }),
			);
		});

		it("should let --timeout override the package timeouts", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			harness.loadPackageConfig.mockResolvedValue({ timeout: 1234 });
			await runSinglePackageAsync(harness, {
				name: "a",
				cli: { backend: "studio-cli", packages: "a", timeout: 5 },
			});

			expect(backendSettings(harness)).toMatchObject({ timeout: 5 });
		});

		it("should forward cli.headed to the studio-cli backend", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			runWorkspaceReturns({
				...harness,
				results: [{ displayName: "a", pkg: "a", result: makeExecuteResult() }],
			});

			await runWorkspaceModeAsync({
				cli: makeCli({
					backend: "studio-cli",
					headed: true,
					packages: "a",
					workspace: true,
				}),
				dependencies: harness.dependencies,
			});

			expect(backendSettings(harness)).toMatchObject({ headed: true });
		});

		it("should resolve the attached studio backend without Open Cloud credentials", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			await runSinglePackageAsync(harness, {
				name: "a",
				cli: { backend: "studio", packages: "a" },
			});

			expect(backendSettings(harness)).toStrictEqual({
				kind: "studio",
				port: createResolvedConfig().port,
				timeout: createResolvedConfig().timeout,
			});
			expect(harness.openBackend).toHaveBeenCalledOnce();
		});
	});

	describe("--packages happy path", () => {
		it("should resolve every package and forward them to runWorkspace", async () => {
			expect.assertions(3);

			const harness = setupHappyPath();
			runWorkspaceReturns({
				...harness,
				results: [
					{
						displayName: "@halcyon/foo",
						pkg: "@halcyon/foo",
						result: makeExecuteResult(),
					},
					{
						displayName: "@halcyon/bar",
						pkg: "@halcyon/bar",
						result: makeExecuteResult(),
					},
				],
			});

			const result = await runWorkspaceModeAsync({
				cli: makeCli({ packages: "@halcyon/foo,@halcyon/bar", workspace: true }),
				dependencies: harness.dependencies,
			});

			expect(result.validationExitCode).toBeUndefined();
			expect(result.projectResults).toHaveLength(2);
			expect(packageNames(harness)).toStrictEqual(["@halcyon/foo", "@halcyon/bar"]);
		});

		it("should emit the run header to stdout before running the workspace", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			await runSinglePackageAsync(harness, {
				name: "@halcyon/foo",
				cli: { packages: "@halcyon/foo" },
			});

			expect(stdout).toHaveBeenCalledWith(expect.stringContaining(" RUN "));
		});

		it("should not emit the run header when silent", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			await runSinglePackageAsync(harness, {
				name: "@halcyon/foo",
				cli: {
					packages: "@halcyon/foo",
					silent: true,
				},
			});

			expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining(" RUN "));
		});

		it("should surface consensus-resolved sink paths on the result", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			harness.loadPackageConfig.mockResolvedValue({ gameOutput: true, outputFile: true });
			const result = await runSinglePackageAsync(harness, {
				name: "@halcyon/foo",
				cli: {
					packages: "@halcyon/foo",
				},
			});

			expect(result.output!.gameOutput).toBe(path.join(ROOT, "game-output.log"));
			expect(result.output!.outputFile).toBe(path.join(ROOT, "jest-output.log"));
		});

		it("should collapse displayName when project name matches package name", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			const result = await runSinglePackageAsync(harness, {
				name: "@halcyon/foo",
				cli: {
					packages: "@halcyon/foo",
				},
			});

			expect(result.projectResults[0]!.displayName).toBe("@halcyon/foo");
		});

		it("should pass an onStreamingResult hook when the default human formatter is active", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();

			await runWorkspaceModeAsync({
				cli: makeCli({ packages: "@halcyon/foo", workspace: true }),
				dependencies: harness.dependencies,
			});

			expect(runnerCall(harness).onStreamingResult).toBeFunction();
		});

		it("should omit onStreamingResult when the JSON formatter is active", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();

			await runWorkspaceModeAsync({
				cli: makeCli({ formatters: ["json"], packages: "@halcyon/foo", workspace: true }),
				dependencies: harness.dependencies,
			});

			expect(runnerCall(harness).onStreamingResult).toBeUndefined();
		});

		it("should omit onStreamingResult when silent is true", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();

			await runWorkspaceModeAsync({
				cli: makeCli({ packages: "@halcyon/foo", silent: true, workspace: true }),
				dependencies: harness.dependencies,
			});

			expect(runnerCall(harness).onStreamingResult).toBeUndefined();
		});

		it("should omit onStreamingResult when the non-verbose agent formatter is active", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();

			await runWorkspaceModeAsync({
				cli: makeCli({ formatters: ["agent"], packages: "@halcyon/foo", workspace: true }),
				dependencies: harness.dependencies,
			});

			expect(runnerCall(harness).onStreamingResult).toBeUndefined();
		});

		it("should write a progress line to stdout when the human-formatter sink is called", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();

			const writes: Array<string> = [];
			const writeSpy = vi
				.spyOn(process.stdout, "write")
				.mockImplementation((chunk: Parameters<typeof process.stdout.write>[0]) => {
					writes.push(toStdoutText(chunk));
					return true;
				});

			await runWorkspaceModeAsync({
				cli: makeCli({ color: false, packages: "@halcyon/foo", workspace: true }),
				dependencies: harness.dependencies,
			});

			const { onStreamingResult } = runnerCall(harness);
			onStreamingResult!({
				elapsedMs: 42,
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				pkg: "@halcyon/foo",
				project: "@halcyon/foo",
				success: true,
			});
			writeSpy.mockRestore();

			// Whole write, not a substring: the line ends at its newline, and a
			// `toContain` here let a template literal smuggle a trailing indent
			// onto every streaming line.
			expect(writes.at(-1)).toBe("▶ @halcyon/foo  1 passed (42ms)\n");
		});

		it("should compose 'pkg › project' when names differ", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			runWorkspaceReturns({
				...harness,
				results: [
					{ displayName: "client", pkg: "@halcyon/foo", result: makeExecuteResult() },
					{ displayName: "server", pkg: "@halcyon/foo", result: makeExecuteResult() },
				],
			});

			const result = await runWorkspaceModeAsync({
				cli: makeCli({ packages: "@halcyon/foo", workspace: true }),
				dependencies: harness.dependencies,
			});

			expect(result.projectResults[0]!.displayName).toBe("@halcyon/foo › client");
			expect(result.projectResults[1]!.displayName).toBe("@halcyon/foo › server");
		});

		// One package can own several projects, so the bail summary counts
		// packages on both sides rather than the project rows on show.
		it("should report how far a bailed run got, by package", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			harness.runWorkspace.mockResolvedValue({
				bailedPackages: ["@halcyon/bar", "@halcyon/baz"],
				coverageMs: 0,
				results: [
					{
						displayName: "client",
						pkg: "@halcyon/foo",
						result: makeExecuteResult(),
					},
					{
						displayName: "server",
						pkg: "@halcyon/foo",
						result: makeExecuteResult(),
					},
					{
						displayName: "shared",
						pkg: "@halcyon/qux",
						result: makeExecuteResult(),
					},
				],
				stagingMs: 0,
			});

			const result = await runWorkspaceModeAsync({
				cli: makeCli({ bail: true, packages: "@halcyon/foo", workspace: true }),
				dependencies: harness.dependencies,
			});

			expect(result.bail).toStrictEqual({ notRun: 2, ran: 2 });

			harness.runWorkspace.mockResolvedValue({
				bailedPackages: [],
				coverageMs: 0,
				results: [
					{ displayName: "unit", pkg: "@halcyon/foo", result: makeExecuteResult() },
				],
				stagingMs: 0,
			});
			const complete = await runWorkspaceModeAsync({
				cli: makeCli({ bail: true, packages: "@halcyon/foo", workspace: true }),
				dependencies: harness.dependencies,
			});

			expect(complete.bail).toBeUndefined();
		});

		it("should leave the bail summary off a run that reached every package", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			const result = await runSinglePackageAsync(harness, {
				name: "@halcyon/foo",
				cli: {
					packages: "@halcyon/foo",
				},
			});

			expect(result.bail).toBeUndefined();
		});

		it("should forward the type test result alongside runtime project results", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			runWorkspaceReturns({
				...harness,
				results: [
					{
						displayName: "@halcyon/foo",
						pkg: "@halcyon/foo",
						result: makeExecuteResult(),
					},
				],
				typecheckResult: makeJestResult(),
			});

			const result = await runWorkspaceModeAsync({
				cli: makeCli({ packages: "@halcyon/foo", workspace: true }),
				dependencies: harness.dependencies,
			});

			expect(result.typecheckResult).toBeDefined();
			expect(result.projectResults).toHaveLength(1);
		});

		it("should surface a type-only result without collapsing to the empty result", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			const typecheckResult = makeJestResult({ numFailedTests: 1, success: false });
			runWorkspaceReturns({ ...harness, results: [], typecheckResult });

			const result = await runWorkspaceModeAsync({
				cli: makeCli({ packages: "@halcyon/foo", typecheckOnly: true, workspace: true }),
				dependencies: harness.dependencies,
			});

			expect(result.typecheckResult).toStrictEqual(typecheckResult);
			expect(result.projectResults).toStrictEqual([]);
		});

		it("should resolve no backend and print no header for a run that opens none", async () => {
			expect.assertions(3);

			const harness = setupHappyPath();
			harness.runWorkspace.mockResolvedValue({
				bailedPackages: [],
				coverageMs: 0,
				results: [],
				stagingMs: 0,
				typecheckResult: makeJestResult(),
			});
			const isStudioInstalled = vi.fn<() => boolean>(() => true);
			const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			await runWorkspaceModeAsync({
				cli: makeCli({ backend: "auto", packages: "@halcyon/foo", workspace: true }),
				dependencies: { ...harness.dependencies, isStudioInstalled },
			});

			expect(isStudioInstalled).not.toHaveBeenCalled();
			expect(harness.openBackend).not.toHaveBeenCalled();
			expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining(" RUN "));
		});
	});

	describe("workspace.packages enumeration", () => {
		it("should enumerate from workspace.packages without discovering a PM root", async () => {
			expect.assertions(2);

			const harness = setupHappyPath(seedWorkspace(CONFIG_ROOT, ["foo"]));
			const result = await runSinglePackageAsync(harness, {
				name: "foo",
				cli: { packages: "foo" },
				workspace: { packages: ["packages/*"], root: CONFIG_ROOT },
			});

			expect(result.validationExitCode).toBeUndefined();
			expect(runnerCall(harness).packages.map(({ info }) => info)).toStrictEqual([
				{ name: "foo", packageDirectory: packageDirectoryFor(CONFIG_ROOT, "foo") },
			]);
		});

		it("should drive the aggregate sink root off workspace.root", async () => {
			expect.assertions(1);

			const harness = setupHappyPath(seedWorkspace(CONFIG_ROOT, ["foo"]));
			harness.loadPackageConfig.mockResolvedValue({ outputFile: true });
			const result = await runSinglePackageAsync(harness, {
				name: "foo",
				cli: { packages: "foo" },
				workspace: { packages: ["packages/*"], root: CONFIG_ROOT },
			});

			expect(result.output!.outputFile).toBe(path.join(CONFIG_ROOT, "jest-output.log"));
		});
	});

	describe("--affected-since happy path", () => {
		it("should ask turbo for the affected set and resolve every name", async () => {
			expect.assertions(3);

			stubLinux();
			const harness = setupHappyPath(seedTurboWorkspace(ROOT, WORKSPACE_PACKAGES));
			turboReturns({
				childProcess: harness.childProcess,
				names: ["@halcyon/foo", "@halcyon/bar"],
				root: ROOT,
			});
			runWorkspaceReturns({
				...harness,
				results: [
					{
						displayName: "@halcyon/foo",
						pkg: "@halcyon/foo",
						result: makeExecuteResult(),
					},
					{
						displayName: "@halcyon/bar",
						pkg: "@halcyon/bar",
						result: makeExecuteResult(),
					},
				],
			});

			const result = await runWorkspaceModeAsync({
				cli: makeCli({ affectedSince: "main", workspace: true }),
				dependencies: harness.dependencies,
			});

			expect(result.projectResults).toHaveLength(2);
			expect(harness.childProcess.execFileSync).toHaveBeenCalledExactlyOnceWith(
				"turbo",
				["ls", "--filter=...[main]", "--output=json"],
				expect.objectContaining({ cwd: ROOT }),
			);
			expect(packageNames(harness)).toStrictEqual(["@halcyon/foo", "@halcyon/bar"]);
		});

		it("should write a stdout notice and return empty when affected list is empty", async () => {
			expect.assertions(3);

			stubLinux();
			const harness = setupHappyPath(seedTurboWorkspace(ROOT, WORKSPACE_PACKAGES));
			turboReturns({ childProcess: harness.childProcess, names: [], root: ROOT });
			const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = await runWorkspaceModeAsync({
				cli: makeCli({ affectedSince: "main", workspace: true }),
				dependencies: harness.dependencies,
			});

			expect(result.projectResults).toStrictEqual([]);
			expect(result.validationExitCode).toBeUndefined();
			expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("nothing to test"));
		});
	});

	describe("error handling", () => {
		it("should let discoverWorkspaceRoot errors propagate", async () => {
			expect.assertions(1);

			const { dependencies } = setupHappyPath({});

			await expect(
				runWorkspaceModeAsync({
					cli: makeCli({ packages: "@halcyon/foo", workspace: true }),
					dependencies,
				}),
			).rejects.toThrow("No workspace root");
		});

		it("should let enumeration errors propagate", async () => {
			expect.assertions(1);

			const { dependencies } = setupHappyPath();

			await expect(
				runWorkspaceModeAsync({
					cli: makeCli({ packages: "@halcyon/absent", workspace: true }),
					dependencies,
				}),
			).rejects.toThrow('Package "@halcyon/absent" not found in workspace');
		});

		it("should let credentials errors propagate", async () => {
			expect.assertions(1);

			const { dependencies } = setupHappyPath();
			for (const suffix of CREDENTIAL_SUFFIXES) {
				vi.stubEnv(`JEST_ROBLOX_${suffix}`, "");
			}

			await expect(
				runWorkspaceModeAsync({
					cli: makeCli({ packages: "@halcyon/foo", workspace: true }),
					dependencies,
				}),
			).rejects.toThrow("Open Cloud credentials are required");
		});

		it("should reject empty --packages list after trimming", async () => {
			expect.assertions(2);

			const { dependencies } = setupHappyPath();

			const result = await runWorkspaceModeAsync({
				cli: makeCli({ packages: " , , ", workspace: true }),
				dependencies,
			});

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain("--packages names no packages");
		});

		it("should return validationExitCode 2 with no message when runWorkspace returns undefined", async () => {
			expect.assertions(3);

			const harness = setupHappyPath();
			harness.runWorkspace.mockResolvedValue(undefined);

			const result = await runWorkspaceModeAsync({
				cli: makeCli({ packages: "@halcyon/foo", workspace: true }),
				dependencies: harness.dependencies,
			});

			expect(result.validationExitCode).toBe(2);
			expect(result).not.toHaveProperty("validationMessage");
			expect(result.projectResults).toStrictEqual([]);
		});

		it("should let workspace consensus conflicts propagate", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			harness.loadPackageConfig.mockImplementation(async ({ cwd }) => {
				return colorForPackageDirectory(cwd);
			});

			await expect(
				runWorkspaceModeAsync({
					cli: makeCli({ packages: "@halcyon/foo,@halcyon/bar", workspace: true }),
					dependencies: harness.dependencies,
				}),
			).rejects.toThrow("workspace packages disagree on `color`");
		});

		it("should read each package config through the run's own filesystem and runner", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			await runSinglePackageAsync(harness, {
				name: "@halcyon/foo",
				cli: { packages: "@halcyon/foo" },
			});

			expect(harness.loadPackageConfig).toHaveBeenCalledExactlyOnceWith({
				childProcess: harness.dependencies.childProcess,
				configPath: undefined,
				cwd: packageDirectoryFor(ROOT, "@halcyon/foo"),
				fileSystem: harness.dependencies.fileSystem,
			});
		});

		it("should let loadRawConfig errors propagate", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			harness.loadPackageConfig.mockRejectedValueOnce(new Error("Bad config file"));

			await expect(
				runWorkspaceModeAsync({
					cli: makeCli({ packages: "@halcyon/foo", workspace: true }),
					dependencies: harness.dependencies,
				}),
			).rejects.toThrow("Bad config file");
		});
	});

	describe("coverage aggregation", () => {
		it("should aggregate when a runtime result has a coverage manifest even if workspace collectCoverage is false", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			runWorkspaceReturns({
				...harness,
				results: [
					{
						coverageManifest: MANIFEST,
						coverageSettings: coverageSettingsStub(),
						displayName: "@halcyon/foo",
						pkg: "@halcyon/foo",
						result: makeExecuteResult({
							coverageData: { "out/foo.luau": { s: { "1": 3 } } },
						}),
					},
				],
			});

			await runWorkspaceModeAsync({
				cli: makeCli({ packages: "@halcyon/foo", workspace: true }),
				dependencies: harness.dependencies,
			});

			expect(harness.dependencies.mapCoverage).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ manifest: MANIFEST }),
			);
		});

		it("should leave coverage undefined when no package carries a manifest", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			const result = await runSinglePackageAsync(harness, {
				name: "@halcyon/foo",
				cli: {
					packages: "@halcyon/foo",
				},
			});

			expect(result.coverage).toBeUndefined();
		});
	});

	it("should carry the runner's staging and coverage times out apart", async () => {
		expect.assertions(2);

		const harness = setupHappyPath();
		harness.runWorkspace.mockResolvedValue({
			bailedPackages: [],
			coverageMs: 1234,
			results: [
				{
					displayName: "foo",
					pkg: "@halcyon/foo",
					result: makeExecuteResult(),
				},
			],
			stagingMs: 567,
		});

		const result = await runWorkspaceModeAsync({
			cli: makeCli({ packages: "@halcyon/foo", workspace: true }),
			dependencies: harness.dependencies,
		});

		expect(result.coverageMs).toBe(1234);
		expect(result.stagingMs).toBe(567);
	});
});
