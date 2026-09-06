import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { Backend, BackendOptions, BackendResult } from "../backends/interface.ts";
import type { createOpenCloudBackend } from "../backends/open-cloud.ts";
import type { createStudioCliBackend } from "../backends/studio-cli.ts";
import type { createStudioBackend } from "../backends/studio.ts";
import type { loadRawConfig } from "../config/loader.ts";
import type { CliOptions } from "../config/schema.ts";
import { MANIFEST_VERSION } from "../coverage-pipeline/manifest.ts";
import type { aggregateWorkspaceCoverage } from "../coverage-pipeline/workspace-aggregate.ts";
import type { ExecuteResult } from "../executor.ts";
import type { JestResult } from "../types/jest-result.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { runWorkspaceAsync, WorkspaceProjectResult } from "../workspace-runner.ts";
import type { PackageCoverageSettings } from "../workspace/coverage-attach.ts";
import type { WorkspaceModeDependencies } from "./workspace.ts";
import { runWorkspaceModeAsync } from "./workspace.ts";

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

function turboReturns(childProcess: ChildProcessRunner, root: string, names: Array<string>): void {
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

function coverageSettingsStub(): PackageCoverageSettings {
	return {
		coverageDirectory: "/ws/packages/foo/coverage",
		coverageReporters: ["text", "lcov"],
		rootDir: "/ws/packages/foo",
	};
}

function makeExecuteResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
	return {
		exitCode: 0,
		output: "",
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
	return {
		closeAsync: vi.fn<() => void>(),
		kind,
		runTestsAsync: vi.fn<(options: BackendOptions) => Promise<BackendResult>>(async () => {
			return { rawResults: [], timing: { executionMs: 0 } };
		}),
	};
}

function toStdoutText(chunk: Parameters<typeof process.stdout.write>[0]): string {
	return typeof chunk === "string" ? chunk : String(chunk);
}

/** Per-package `color`, disagreeing across packages to trip consensus. */
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

type Harness = ReturnType<typeof setupHappyPath>;

function setupHappyPath(seed: Record<string, string> = seedWorkspace(ROOT, WORKSPACE_PACKAGES)) {
	vi.spyOn(process, "cwd").mockReturnValue(ROOT);
	stubCredentials();

	const backend = makeFakeBackend();
	const { fileSystem } = createMemoryFileSystem(seed, ROOT);
	const childProcess = createRunner();
	const aggregateCoverage = vi.fn<typeof aggregateWorkspaceCoverage>(() => []);
	const loadPackageConfig = vi.fn<typeof loadRawConfig>(async () => ({}));
	const openCloudBackend = vi.fn<typeof createOpenCloudBackend>(() => fromAny(backend));
	const runWorkspace = vi.fn<typeof runWorkspaceAsync>(async () => ({ results: [] }));
	const studioBackend = vi.fn<typeof createStudioBackend>(() => {
		return fromAny(makeFakeBackend("studio"));
	});
	const studioCliBackend = vi.fn<typeof createStudioCliBackend>(() => {
		return fromAny(makeFakeBackend("studio-cli"));
	});

	const dependencies: WorkspaceModeDependencies = {
		aggregateCoverage,
		childProcess,
		fileSystem,
		loadPackageConfig,
		openCloudBackend,
		runWorkspace,
		studioBackend,
		studioCliBackend,
	};

	return {
		aggregateCoverage,
		backend,
		childProcess,
		dependencies,
		loadPackageConfig,
		openCloudBackend,
		runWorkspace,
		studioBackend,
		studioCliBackend,
	};
}

function runWorkspaceReturns(
	{ runWorkspace }: Harness,
	results: Array<WorkspaceProjectResult>,
	typecheckResult?: JestResult,
): void {
	runWorkspace.mockResolvedValue({ results, typecheckResult });
}

function runnerCall({ runWorkspace }: Harness) {
	return runWorkspace.mock.calls[0]![0];
}

function packageNames(harness: Harness): Array<string> {
	return runnerCall(harness).packageInfos.map((info) => info.name);
}

describe(runWorkspaceModeAsync, () => {
	describe("validation", () => {
		it("should surface mutually-exclusive --packages/--affected-since failure", async () => {
			expect.assertions(2);

			const { dependencies } = setupHappyPath();
			const result = await runWorkspaceModeAsync(
				makeCli({ affectedSince: "main", packages: "a", workspace: true }),
				undefined,
				undefined,
				dependencies,
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain(
				"--packages and --affected-since are mutually exclusive",
			);
		});

		it("should run every enumerated package for a bare --workspace", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			runWorkspaceReturns(harness, [
				{ displayName: "a", pkg: "a", result: makeExecuteResult() },
			]);

			const result = await runWorkspaceModeAsync(
				makeCli({ workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.validationExitCode).toBeUndefined();
			expect(packageNames(harness)).toIncludeSameMembers(WORKSPACE_PACKAGES);
		});

		it("should reject a bare --workspace that enumerates nothing", async () => {
			expect.assertions(3);

			const { dependencies } = setupHappyPath(seedWorkspace(ROOT, []));

			const result = await runWorkspaceModeAsync(
				makeCli({ workspace: true }),
				undefined,
				undefined,
				dependencies,
			);

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

			const result = await runWorkspaceModeAsync(
				makeCli({ workspace: true }),
				{ packages: ["packages/*"], root: CONFIG_ROOT },
				undefined,
				dependencies,
			);

			expect(result.validationMessage).toContain("Widen `workspace.packages`");
		});

		it("should reject studio-cli with --parallel > 1", async () => {
			expect.assertions(2);

			const { dependencies } = setupHappyPath();
			const result = await runWorkspaceModeAsync(
				makeCli({ backend: "studio-cli", packages: "a", parallel: 2, workspace: true }),
				undefined,
				undefined,
				dependencies,
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain("serial");
		});

		it("should accept studio-cli with --parallel auto", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			runWorkspaceReturns(harness, [
				{ displayName: "a", pkg: "a", result: makeExecuteResult() },
			]);
			const result = await runWorkspaceModeAsync(
				makeCli({
					backend: "studio-cli",
					packages: "a",
					parallel: "auto",
					workspace: true,
				}),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.validationExitCode).toBeUndefined();
		});

		// The reported failure: `parallel` comes from the package config, not
		// from a flag the user can drop for the run.
		it('should accept studio-cli when a package config declares parallel "auto"', async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			harness.loadPackageConfig.mockResolvedValue({ parallel: "auto" });
			runWorkspaceReturns(harness, [
				{ displayName: "a", pkg: "a", result: makeExecuteResult() },
			]);
			const result = await runWorkspaceModeAsync(
				makeCli({ backend: "studio-cli", packages: "a", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.validationExitCode).toBeUndefined();
		});
	});

	describe("backend resolution", () => {
		it("should resolve the studio-cli backend without Open Cloud credentials", async () => {
			expect.assertions(3);

			const harness = setupHappyPath();
			runWorkspaceReturns(harness, [
				{ displayName: "a", pkg: "a", result: makeExecuteResult() },
			]);

			await runWorkspaceModeAsync(
				makeCli({ backend: "studio-cli", packages: "a", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(harness.studioCliBackend).toHaveBeenCalledOnce();
			expect(harness.openCloudBackend).not.toHaveBeenCalled();
			expect(runnerCall(harness).backend!.kind).toBe("studio-cli");
		});

		it("should forward the resolved studioPath to the studio-cli backend", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			harness.loadPackageConfig.mockResolvedValue({ studioPath: "C:/s.exe" });
			runWorkspaceReturns(harness, [
				{ displayName: "a", pkg: "a", result: makeExecuteResult() },
			]);

			await runWorkspaceModeAsync(
				makeCli({ backend: "studio-cli", packages: "a", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(harness.studioCliBackend).toHaveBeenCalledWith(
				expect.objectContaining({ studioPath: "C:/s.exe" }),
			);
		});

		it("should forward cli.headed to the studio-cli backend", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			runWorkspaceReturns(harness, [
				{ displayName: "a", pkg: "a", result: makeExecuteResult() },
			]);

			await runWorkspaceModeAsync(
				makeCli({ backend: "studio-cli", headed: true, packages: "a", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(harness.studioCliBackend).toHaveBeenCalledWith(
				expect.objectContaining({ headed: true }),
			);
		});

		it("should resolve the attached studio backend without Open Cloud credentials", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			runWorkspaceReturns(harness, [
				{ displayName: "a", pkg: "a", result: makeExecuteResult() },
			]);

			await runWorkspaceModeAsync(
				makeCli({ backend: "studio", packages: "a", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(harness.studioBackend).toHaveBeenCalledOnce();
			expect(harness.openCloudBackend).not.toHaveBeenCalled();
		});
	});

	describe("--packages happy path", () => {
		it("should resolve every package and forward them to runWorkspace", async () => {
			expect.assertions(3);

			const harness = setupHappyPath();
			runWorkspaceReturns(harness, [
				{ displayName: "@halcyon/foo", pkg: "@halcyon/foo", result: makeExecuteResult() },
				{ displayName: "@halcyon/bar", pkg: "@halcyon/bar", result: makeExecuteResult() },
			]);

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo,@halcyon/bar", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.validationExitCode).toBeUndefined();
			expect(result.projectResults).toHaveLength(2);
			expect(packageNames(harness)).toStrictEqual(["@halcyon/foo", "@halcyon/bar"]);
		});

		it("should emit the run header to stdout before running the workspace", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			runWorkspaceReturns(harness, [
				{ displayName: "@halcyon/foo", pkg: "@halcyon/foo", result: makeExecuteResult() },
			]);
			const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(stdout).toHaveBeenCalledWith(expect.stringContaining(" RUN "));
		});

		it("should not emit the run header when silent", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			runWorkspaceReturns(harness, [
				{ displayName: "@halcyon/foo", pkg: "@halcyon/foo", result: makeExecuteResult() },
			]);
			const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", silent: true, workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining(" RUN "));
		});

		it("should surface consensus-resolved sink paths on the result", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			harness.loadPackageConfig.mockResolvedValue({ gameOutput: true, outputFile: true });
			runWorkspaceReturns(harness, [
				{ displayName: "@halcyon/foo", pkg: "@halcyon/foo", result: makeExecuteResult() },
			]);

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.gameOutput).toBe(path.join(ROOT, "game-output.log"));
			expect(result.outputFile).toBe(path.join(ROOT, "jest-output.log"));
		});

		it("should forward the resolved base URL onto workStealingCredentials", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_BASE_URL", "http://127.0.0.1:4010/");

			await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(runnerCall(harness).workStealingCredentials!.baseUrl).toBe(
				"http://127.0.0.1:4010",
			);
		});

		it("should collapse displayName when project name matches package name", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			runWorkspaceReturns(harness, [
				{ displayName: "@halcyon/foo", pkg: "@halcyon/foo", result: makeExecuteResult() },
			]);

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.projectResults[0]!.displayName).toBe("@halcyon/foo");
		});

		it("should pass an onStreamingResult hook when the default human formatter is active", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();

			await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(runnerCall(harness).onStreamingResult).toBeFunction();
		});

		it("should omit onStreamingResult when the JSON formatter is active", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();

			await runWorkspaceModeAsync(
				makeCli({ formatters: ["json"], packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(runnerCall(harness).onStreamingResult).toBeUndefined();
		});

		it("should omit onStreamingResult when silent is true", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();

			await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", silent: true, workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(runnerCall(harness).onStreamingResult).toBeUndefined();
		});

		it("should omit onStreamingResult when the non-verbose agent formatter is active", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();

			await runWorkspaceModeAsync(
				makeCli({ formatters: ["agent"], packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

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

			await runWorkspaceModeAsync(
				makeCli({ color: false, packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

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
			runWorkspaceReturns(harness, [
				{ displayName: "client", pkg: "@halcyon/foo", result: makeExecuteResult() },
				{ displayName: "server", pkg: "@halcyon/foo", result: makeExecuteResult() },
			]);

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.projectResults[0]!.displayName).toBe("@halcyon/foo › client");
			expect(result.projectResults[1]!.displayName).toBe("@halcyon/foo › server");
		});

		// One package can own several projects, so the bail summary counts
		// packages on both sides rather than the project rows on show.
		it("should report how far a bailed run got, by package", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			harness.runWorkspace.mockResolvedValue({
				bailedPackages: ["@halcyon/bar", "@halcyon/baz"],
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
				],
			});

			const result = await runWorkspaceModeAsync(
				makeCli({ bail: true, packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.bail).toStrictEqual({ notRun: 2, ran: 1 });
		});

		it("should leave the bail summary off a run that reached every package", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			runWorkspaceReturns(harness, [
				{ displayName: "@halcyon/foo", pkg: "@halcyon/foo", result: makeExecuteResult() },
			]);

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.bail).toBeUndefined();
		});

		it("should forward the type test result alongside runtime project results", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			runWorkspaceReturns(
				harness,
				[{ displayName: "@halcyon/foo", pkg: "@halcyon/foo", result: makeExecuteResult() }],
				makeJestResult(),
			);

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.typecheckResult).toBeDefined();
			expect(result.projectResults).toHaveLength(1);
		});

		it("should surface a type-only result without collapsing to the empty result", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			const typecheckResult = makeJestResult({ numFailedTests: 1, success: false });
			runWorkspaceReturns(harness, [], typecheckResult);

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", typecheckOnly: true, workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.typecheckResult).toStrictEqual(typecheckResult);
			expect(result.projectResults).toStrictEqual([]);
		});

		it("should not create an Open Cloud backend under --typecheckOnly", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			runWorkspaceReturns(harness, [], makeJestResult());

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", typecheckOnly: true, workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			// Pure-local tsgo needs no credentials: the backend (and its secrets)
			// must not be created when there is no Open Cloud dispatch.
			expect(harness.openCloudBackend).not.toHaveBeenCalled();
			expect(result.typecheckResult).toBeDefined();
		});
	});

	describe("workspace.packages enumeration", () => {
		it("should enumerate from workspace.packages without discovering a PM root", async () => {
			expect.assertions(2);

			const harness = setupHappyPath(seedWorkspace(CONFIG_ROOT, ["foo"]));
			runWorkspaceReturns(harness, [
				{ displayName: "foo", pkg: "foo", result: makeExecuteResult() },
			]);

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "foo", workspace: true }),
				{ packages: ["packages/*"], root: CONFIG_ROOT },
				undefined,
				harness.dependencies,
			);

			expect(result.validationExitCode).toBeUndefined();
			expect(runnerCall(harness).packageInfos).toStrictEqual([
				{ name: "foo", packageDirectory: packageDirectoryFor(CONFIG_ROOT, "foo") },
			]);
		});

		it("should drive the aggregate sink root off workspace.root", async () => {
			expect.assertions(1);

			const harness = setupHappyPath(seedWorkspace(CONFIG_ROOT, ["foo"]));
			harness.loadPackageConfig.mockResolvedValue({ outputFile: true });
			runWorkspaceReturns(harness, [
				{ displayName: "foo", pkg: "foo", result: makeExecuteResult() },
			]);

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "foo", workspace: true }),
				{ packages: ["packages/*"], root: CONFIG_ROOT },
				undefined,
				harness.dependencies,
			);

			expect(result.outputFile).toBe(path.join(CONFIG_ROOT, "jest-output.log"));
		});
	});

	describe("--affected-since happy path", () => {
		it("should ask turbo for the affected set and resolve every name", async () => {
			expect.assertions(3);

			stubLinux();
			const harness = setupHappyPath(seedTurboWorkspace(ROOT, WORKSPACE_PACKAGES));
			turboReturns(harness.childProcess, ROOT, ["@halcyon/foo", "@halcyon/bar"]);
			runWorkspaceReturns(harness, [
				{ displayName: "@halcyon/foo", pkg: "@halcyon/foo", result: makeExecuteResult() },
				{ displayName: "@halcyon/bar", pkg: "@halcyon/bar", result: makeExecuteResult() },
			]);

			const result = await runWorkspaceModeAsync(
				makeCli({ affectedSince: "main", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

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
			turboReturns(harness.childProcess, ROOT, []);
			const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = await runWorkspaceModeAsync(
				makeCli({ affectedSince: "main", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.projectResults).toStrictEqual([]);
			expect(result.validationExitCode).toBeUndefined();
			expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("nothing to test"));
		});
	});

	describe("error handling", () => {
		it("should surface discoverWorkspaceRoot errors as validation message", async () => {
			expect.assertions(2);

			const { dependencies } = setupHappyPath({});

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				dependencies,
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain("No workspace root");
		});

		it("should surface enumeration errors as validation message", async () => {
			expect.assertions(2);

			const { dependencies } = setupHappyPath();

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/absent", workspace: true }),
				undefined,
				undefined,
				dependencies,
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain(
				'Package "@halcyon/absent" not found in workspace',
			);
		});

		it("should surface credentials errors as validation message", async () => {
			expect.assertions(2);

			const { dependencies } = setupHappyPath();
			for (const suffix of CREDENTIAL_SUFFIXES) {
				vi.stubEnv(`JEST_ROBLOX_${suffix}`, "");
			}

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				dependencies,
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain("Open Cloud credentials are required");
		});

		it("should reject empty --packages list after trimming", async () => {
			expect.assertions(2);

			const { dependencies } = setupHappyPath();

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: " , , ", workspace: true }),
				undefined,
				undefined,
				dependencies,
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain("--packages names no packages");
		});

		it("should return validationExitCode 2 with no message when runWorkspace returns undefined", async () => {
			expect.assertions(3);

			const harness = setupHappyPath();
			harness.runWorkspace.mockResolvedValue(undefined);

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.validationExitCode).toBe(2);
			expect(result).not.toHaveProperty("validationMessage");
			expect(result.projectResults).toStrictEqual([]);
		});

		it("should close the backend when runWorkspace throws", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			harness.runWorkspace.mockRejectedValue(new Error("boom"));

			await expect(
				runWorkspaceModeAsync(
					makeCli({ packages: "@halcyon/foo", workspace: true }),
					undefined,
					undefined,
					harness.dependencies,
				),
			).rejects.toThrow("boom");

			expect(harness.backend.closeAsync).toHaveBeenCalledWith();
		});

		it("should surface workspace consensus conflicts as validation message", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			harness.loadPackageConfig.mockImplementation(async (_configPath, cwd) => {
				return colorForPackageDirectory(cwd);
			});

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo,@halcyon/bar", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain("workspace packages disagree on `color`");
		});

		it("should read each package config through the run's own filesystem", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			runWorkspaceReturns(harness, [
				{ displayName: "@halcyon/foo", pkg: "@halcyon/foo", result: makeExecuteResult() },
			]);

			await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(harness.loadPackageConfig).toHaveBeenCalledExactlyOnceWith(
				undefined,
				packageDirectoryFor(ROOT, "@halcyon/foo"),
				{ fileSystem: harness.dependencies.fileSystem },
			);
		});

		it("should surface loadRawConfig errors without double-prefixing Error:", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			harness.loadPackageConfig.mockRejectedValueOnce(new Error("Bad config file"));

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toBe("Error: Bad config file\n");
		});

		it("should stringify non-Error throws from config loading", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			harness.loadPackageConfig.mockRejectedValueOnce("raw string failure");

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toBe("Error: raw string failure\n");
		});

		it("should stringify non-Error throws from credential building", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			harness.openCloudBackend.mockImplementation(() => {
				// eslint-disable-next-line ts/only-throw-error -- exercising the non-Error branch
				throw "raw credential failure";
			});

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toBe("Error: raw credential failure\n");
		});
	});

	describe("coverage aggregation", () => {
		it("should feed each package's own coverage inputs into the aggregator", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			runWorkspaceReturns(harness, [
				{
					coverageManifest: MANIFEST,
					coverageSettings: {
						collectCoverageFrom: ["src/**/*.ts"],
						coverageDirectory: "/ws/packages/foo/coverage",
						coveragePathIgnorePatterns: ["**/node_modules/**"],
						coverageReporters: ["text"],
						rootDir: "/ws/packages/foo",
					},
					displayName: "@halcyon/foo",
					pkg: "@halcyon/foo",
					result: makeExecuteResult({
						coverageData: { "out/foo.luau": { s: { "1": 3 } } },
					}),
				},
			]);
			harness.aggregateCoverage.mockReturnValue([
				{ pkg: "@halcyon/foo", universe: { files: {} } },
			]);

			const result = await runWorkspaceModeAsync(
				makeCli({ collectCoverage: true, packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			// The package's own globs reach the aggregator, along with the
			// rootDir they are written relative to, so the universe it builds
			// is the one both the report and the gate see.
			expect(harness.aggregateCoverage).toHaveBeenCalledWith([
				expect.objectContaining({
					coverageData: { "out/foo.luau": { s: { "1": 3 } } },
					ignorePatterns: ["**/node_modules/**"],
					includePatterns: ["src/**/*.ts"],
					manifest: MANIFEST,
					pkg: "@halcyon/foo",
					rootDir: "/ws/packages/foo",
				}),
			]);
			expect(result.coveragePackages).toHaveLength(1);
		});

		it("should merge raw coverageData across same-pkg multi-project entries and skip pkgs without a manifest", async () => {
			expect.assertions(3);

			const harness = setupHappyPath();
			runWorkspaceReturns(harness, [
				// Two projects under the same pkg — coverageData must MERGE
				// (each project runs Jest with its own _G.__jest_roblox_cov
				// reset, so the maps are disjoint).
				{
					coverageManifest: MANIFEST,
					coverageSettings: coverageSettingsStub(),
					displayName: "client",
					pkg: "@halcyon/foo",
					result: makeExecuteResult({
						coverageData: { "out/foo.luau": { s: { "1": 3 } } },
					}),
				},
				{
					coverageManifest: MANIFEST,
					coverageSettings: coverageSettingsStub(),
					displayName: "server",
					pkg: "@halcyon/foo",
					result: makeExecuteResult({
						coverageData: { "out/foo.luau": { s: { "1": 4 } } },
					}),
				},
				// Different pkg, no manifest — must be skipped.
				{
					displayName: "@halcyon/bar",
					pkg: "@halcyon/bar",
					result: makeExecuteResult(),
				},
			]);

			await runWorkspaceModeAsync(
				makeCli({ collectCoverage: true, packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			const aggregateCall = harness.aggregateCoverage.mock.calls[0]![0];

			expect(aggregateCall).toHaveLength(1);
			expect(aggregateCall[0]!.pkg).toBe("@halcyon/foo");
			// 3 + 4 = 7 — both project hits summed.
			expect(aggregateCall[0]!.coverageData!["out/foo.luau"]!.s["1"]).toBe(7);
		});

		it("should expose an empty gate list when the aggregator returns no universes", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			runWorkspaceReturns(harness, [
				{
					coverageManifest: MANIFEST,
					coverageSettings: coverageSettingsStub(),
					displayName: "@halcyon/foo",
					pkg: "@halcyon/foo",
					result: makeExecuteResult(),
				},
			]);

			// Coverage ran but no package produced data: `coveragePackages` is
			// present-but-empty, which is what tells the report layer to emit
			// nothing rather than an empty table.
			const result = await runWorkspaceModeAsync(
				makeCli({ collectCoverage: true, packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.coveragePackages).toStrictEqual([]);
		});

		it("should not aggregate when no runtime results carry a coverage manifest", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();
			runWorkspaceReturns(harness, [
				{
					displayName: "@halcyon/foo",
					pkg: "@halcyon/foo",
					result: makeExecuteResult(),
				},
			]);

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(harness.aggregateCoverage).not.toHaveBeenCalled();
			expect(result.coveragePackages).toBeUndefined();
		});

		// Per-package opt-in: the workspace runner instrumented foo and
		// attached a manifest. The outer `runWorkspaceMode` must still produce
		// a coverage report instead of gating on the workspace root's
		// `collectCoverage` flag.
		it("should aggregate when a runtime result has a coverage manifest even if workspace collectCoverage is false", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			const { aggregateCoverage, ...dependencies } = harness.dependencies;
			runWorkspaceReturns(harness, [
				{
					coverageManifest: MANIFEST,
					coverageSettings: coverageSettingsStub(),
					displayName: "@halcyon/foo",
					pkg: "@halcyon/foo",
					result: makeExecuteResult({
						coverageData: { "out/foo.luau": { s: { "1": 3 } } },
					}),
				},
			]);

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				dependencies,
			);

			expect(result.coveragePackages).toHaveLength(1);
		});

		it("should surface per-package coverage gates with each package's own threshold", async () => {
			expect.assertions(3);

			const harness = setupHappyPath();
			runWorkspaceReturns(harness, [
				{
					coverageManifest: MANIFEST,
					coverageSettings: {
						coverageDirectory: "/ws/packages/foo/coverage",
						coverageReporters: ["text"],
						coverageThreshold: { statements: 90 },
						rootDir: "/ws/packages/foo",
					},
					displayName: "@halcyon/foo",
					pkg: "@halcyon/foo",
					result: makeExecuteResult({
						coverageData: { "out/foo.luau": { s: { "1": 3 } } },
					}),
				},
				// No declared threshold — the gate entry must omit it, so
				// nothing gates the package.
				{
					coverageManifest: MANIFEST,
					coverageSettings: {
						coverageDirectory: "/ws/packages/bar/coverage",
						coverageReporters: ["lcov"],
						rootDir: "/ws/packages/bar",
					},
					displayName: "@halcyon/bar",
					pkg: "@halcyon/bar",
					result: makeExecuteResult({
						coverageData: { "out/bar.luau": { s: { "1": 1 } } },
					}),
				},
			]);

			const fooUniverse = { files: {} };
			const barUniverse = { files: {} };
			harness.aggregateCoverage.mockReturnValue([
				{ pkg: "@halcyon/foo", universe: fooUniverse },
				{ pkg: "@halcyon/bar", universe: barUniverse },
			]);

			const result = await runWorkspaceModeAsync(
				makeCli({ collectCoverage: true, packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.coveragePackages).toStrictEqual([
				{
					coverageDirectory: "/ws/packages/foo/coverage",
					coverageReporters: ["text"],
					coverageThreshold: { statements: 90 },
					pkg: "@halcyon/foo",
					universe: fooUniverse,
				},
				{
					coverageDirectory: "/ws/packages/bar/coverage",
					coverageReporters: ["lcov"],
					pkg: "@halcyon/bar",
					universe: barUniverse,
				},
			]);
			expect(result.coveragePackages![0]!.universe).toBe(fooUniverse);
			expect(result.coveragePackages![1]!.universe).toBe(barUniverse);
		});

		it("should leave coveragePackages undefined when no package carries a manifest", async () => {
			expect.assertions(1);

			const harness = setupHappyPath();
			runWorkspaceReturns(harness, [
				{
					displayName: "@halcyon/foo",
					pkg: "@halcyon/foo",
					result: makeExecuteResult(),
				},
			]);

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.coveragePackages).toBeUndefined();
		});
	});

	describe("empty results", () => {
		it("should return empty projectResults when runWorkspace returns []", async () => {
			expect.assertions(2);

			const harness = setupHappyPath();

			const result = await runWorkspaceModeAsync(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
				undefined,
				undefined,
				harness.dependencies,
			);

			expect(result.validationExitCode).toBeUndefined();
			expect(result.projectResults).toStrictEqual([]);
		});
	});

	it("should carry the runner's staging and coverage times out apart", async () => {
		expect.assertions(2);

		const harness = setupHappyPath();
		harness.runWorkspace.mockResolvedValue({
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

		const result = await runWorkspaceModeAsync(
			makeCli({ packages: "@halcyon/foo", workspace: true }),
			undefined,
			undefined,
			harness.dependencies,
		);

		expect(result.coverageMs).toBe(1234);
		expect(result.stagingMs).toBe(567);
	});
});

describe("workspace report options", () => {
	it("should carry the resolved presentation settings onto the result", async () => {
		expect.assertions(1);

		const harness = setupHappyPath();
		runWorkspaceReturns(harness, [{ displayName: "a", pkg: "a", result: makeExecuteResult() }]);

		const result = await runWorkspaceModeAsync(
			makeCli({ packages: "a", verbose: true, workspace: true }),
			undefined,
			undefined,
			harness.dependencies,
		);

		expect(result.reportOptions).toStrictEqual({
			color: true,
			formatters: ["default"],
			rootDir: ROOT,
			silent: false,
			verbose: true,
		});
	});

	it("should report verbose false when the flag is absent", async () => {
		expect.assertions(1);

		const harness = setupHappyPath();
		runWorkspaceReturns(harness, [{ displayName: "a", pkg: "a", result: makeExecuteResult() }]);

		const result = await runWorkspaceModeAsync(
			makeCli({ packages: "a", workspace: true }),
			undefined,
			undefined,
			harness.dependencies,
		);

		// `cli.verbose` is optional, so the report carries a real boolean
		// rather than the undefined the flag parser leaves behind.
		expect(result.reportOptions!.verbose).toBeFalse();
	});
});
