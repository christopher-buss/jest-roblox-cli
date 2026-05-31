import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import type { Backend, BackendOptions, BackendResult } from "../backends/interface.ts";
import { createOpenCloudBackend, resolveOpenCloudBaseUrl } from "../backends/open-cloud.ts";
import { loadRawConfig } from "../config/loader.ts";
import type { CliOptions } from "../config/schema.ts";
import { MANIFEST_VERSION } from "../coverage/manifest.ts";
import type { ExecuteResult } from "../executor.ts";
import type { JestResult } from "../types/jest-result.ts";
import { runWorkspace } from "../workspace-runner.ts";
import { getAffectedPackages } from "../workspace/affected.ts";
import { discoverWorkspaceRoot } from "../workspace/discovery.ts";
import { resolvePackage } from "../workspace/package-resolver.ts";
import { runWorkspaceMode } from "./workspace.ts";

const stdEnvironmentMock = vi.hoisted(() => ({ isAgent: false }));

vi.mock(import("std-env"), () => stdEnvironmentMock);
vi.mock(import("../workspace-runner.ts"));
vi.mock(import("../workspace/discovery.ts"));
vi.mock(import("../workspace/package-resolver.ts"));
vi.mock(import("../workspace/affected.ts"));
vi.mock(import("../backends/open-cloud.ts"));
vi.mock(import("../config/loader.ts"));
vi.mock(import("../coverage/workspace-aggregate.ts"));
vi.mock(import("@isentinel/roblox-runner"), async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		resolveCredentials: vi.fn<() => { apiKey: string; placeId: string; universeId: string }>(
			() => {
				return { apiKey: "test-key", placeId: "p", universeId: "u" };
			},
		),
	};
});

function makeCli(overrides: Partial<CliOptions> = {}): CliOptions {
	return { backend: "open-cloud", ...overrides };
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

function makeFakeBackend(): Backend {
	return {
		close: vi.fn<() => void>(),
		kind: "open-cloud",
		runTests: vi.fn<(options: BackendOptions) => Promise<BackendResult>>(async () => {
			return { rawResults: [], timing: { executionMs: 0 } };
		}),
	};
}

function setupHappyPath(): { backend: Backend } {
	const backend = makeFakeBackend();
	vi.mocked(discoverWorkspaceRoot).mockReturnValue("/repo");
	vi.mocked(resolvePackage).mockImplementation((_, name) => {
		return { name, packageDirectory: path.posix.join("/repo/packages", name) };
	});
	vi.mocked(createOpenCloudBackend).mockReturnValue(fromAny(backend));
	vi.mocked(runWorkspace).mockResolvedValue([]);
	vi.mocked(loadRawConfig).mockResolvedValue({});
	return { backend };
}

describe(runWorkspaceMode, () => {
	describe("validation", () => {
		it("should surface mutually-exclusive --packages/--affected-since failure", async () => {
			expect.assertions(2);

			setupHappyPath();
			const result = await runWorkspaceMode(
				makeCli({ affectedSince: "main", packages: "a", workspace: true }),
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain(
				"--packages and --affected-since are mutually exclusive",
			);
		});

		it("should surface missing --packages/--affected-since failure", async () => {
			expect.assertions(2);

			setupHappyPath();
			const result = await runWorkspaceMode(makeCli({ workspace: true }));

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain(
				"--workspace requires --packages or --affected-since",
			);
		});

		it("should surface studio-backend-with-workspace failure", async () => {
			expect.assertions(2);

			setupHappyPath();
			const result = await runWorkspaceMode(
				makeCli({ backend: "studio", packages: "a", workspace: true }),
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain("--workspace requires --backend open-cloud");
		});
	});

	describe("--packages happy path", () => {
		it("should resolve every package and forward them to runWorkspace", async () => {
			expect.assertions(3);

			setupHappyPath();
			vi.mocked(runWorkspace).mockResolvedValue([
				{ displayName: "@halcyon/foo", pkg: "@halcyon/foo", result: makeExecuteResult() },
				{ displayName: "@halcyon/bar", pkg: "@halcyon/bar", result: makeExecuteResult() },
			]);

			const result = await runWorkspaceMode(
				makeCli({ packages: "@halcyon/foo,@halcyon/bar", workspace: true }),
			);

			expect(result.validationExitCode).toBeUndefined();
			expect(result.projectResults).toHaveLength(2);
			expect(
				vi.mocked(runWorkspace).mock.calls[0]?.[0].packageInfos.map((info) => info.name),
			).toStrictEqual(["@halcyon/foo", "@halcyon/bar"]);
		});

		it("should emit the run header to stdout before running the workspace", async () => {
			expect.assertions(1);

			setupHappyPath();
			vi.mocked(runWorkspace).mockResolvedValue([
				{ displayName: "@halcyon/foo", pkg: "@halcyon/foo", result: makeExecuteResult() },
			]);
			const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			await runWorkspaceMode(makeCli({ packages: "@halcyon/foo", workspace: true }));

			expect(stdout).toHaveBeenCalledWith(expect.stringContaining(" RUN "));
		});

		it("should not emit the run header when silent", async () => {
			expect.assertions(1);

			setupHappyPath();
			vi.mocked(runWorkspace).mockResolvedValue([
				{ displayName: "@halcyon/foo", pkg: "@halcyon/foo", result: makeExecuteResult() },
			]);
			const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			await runWorkspaceMode(
				makeCli({ packages: "@halcyon/foo", silent: true, workspace: true }),
			);

			expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining(" RUN "));
		});

		it("should surface consensus-resolved sink paths on the result", async () => {
			expect.assertions(2);

			setupHappyPath();
			vi.mocked(loadRawConfig).mockResolvedValue({ gameOutput: true, outputFile: true });
			vi.mocked(runWorkspace).mockResolvedValue([
				{ displayName: "@halcyon/foo", pkg: "@halcyon/foo", result: makeExecuteResult() },
			]);

			const result = await runWorkspaceMode(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
			);

			expect(result.gameOutput).toBe(path.join("/repo", "game-output.log"));
			expect(result.outputFile).toBe(path.join("/repo", "jest-output.log"));
		});

		it("should forward the resolved base URL onto workStealingCredentials", async () => {
			expect.assertions(1);

			setupHappyPath();
			vi.mocked(resolveOpenCloudBaseUrl).mockReturnValue("http://127.0.0.1:4010");
			vi.mocked(runWorkspace).mockResolvedValue([]);

			await runWorkspaceMode(makeCli({ packages: "@halcyon/foo", workspace: true }));

			expect(
				vi.mocked(runWorkspace).mock.calls[0]?.[0].workStealingCredentials?.baseUrl,
			).toBe("http://127.0.0.1:4010");
		});

		it("should collapse displayName when project name matches package name", async () => {
			expect.assertions(1);

			setupHappyPath();
			vi.mocked(runWorkspace).mockResolvedValue([
				{ displayName: "@halcyon/foo", pkg: "@halcyon/foo", result: makeExecuteResult() },
			]);

			const result = await runWorkspaceMode(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
			);

			expect(result.projectResults[0]?.displayName).toBe("@halcyon/foo");
		});

		it("should pass an onStreamingResult hook when the default human formatter is active", async () => {
			expect.assertions(1);

			setupHappyPath();
			vi.mocked(runWorkspace).mockResolvedValue([]);

			await runWorkspaceMode(makeCli({ packages: "@halcyon/foo", workspace: true }));

			expect(vi.mocked(runWorkspace).mock.calls[0]?.[0].onStreamingResult).toBeFunction();
		});

		it("should omit onStreamingResult when the JSON formatter is active", async () => {
			expect.assertions(1);

			setupHappyPath();
			vi.mocked(runWorkspace).mockResolvedValue([]);

			await runWorkspaceMode(
				makeCli({ formatters: ["json"], packages: "@halcyon/foo", workspace: true }),
			);

			expect(vi.mocked(runWorkspace).mock.calls[0]?.[0].onStreamingResult).toBeUndefined();
		});

		it("should omit onStreamingResult when silent is true", async () => {
			expect.assertions(1);

			setupHappyPath();
			vi.mocked(runWorkspace).mockResolvedValue([]);

			await runWorkspaceMode(
				makeCli({ packages: "@halcyon/foo", silent: true, workspace: true }),
			);

			expect(vi.mocked(runWorkspace).mock.calls[0]?.[0].onStreamingResult).toBeUndefined();
		});

		it("should omit onStreamingResult when the non-verbose agent formatter is active", async () => {
			expect.assertions(1);

			setupHappyPath();
			vi.mocked(runWorkspace).mockResolvedValue([]);

			await runWorkspaceMode(
				makeCli({ formatters: ["agent"], packages: "@halcyon/foo", workspace: true }),
			);

			expect(vi.mocked(runWorkspace).mock.calls[0]?.[0].onStreamingResult).toBeUndefined();
		});

		it("should write a progress line to stdout when the human-formatter sink is called", async () => {
			expect.assertions(1);

			setupHappyPath();
			vi.mocked(runWorkspace).mockResolvedValue([]);

			const writes: Array<string> = [];
			const writeSpy = vi
				.spyOn(process.stdout, "write")
				.mockImplementation((chunk: Parameters<typeof process.stdout.write>[0]) => {
					writes.push(typeof chunk === "string" ? chunk : String(chunk));
					return true;
				});

			await runWorkspaceMode(
				makeCli({ color: false, packages: "@halcyon/foo", workspace: true }),
			);

			const onStreamingResult = vi.mocked(runWorkspace).mock.calls[0]?.[0].onStreamingResult;
			onStreamingResult?.({
				elapsedMs: 42,
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				pkg: "@halcyon/foo",
				project: "@halcyon/foo",
				success: true,
			});
			writeSpy.mockRestore();

			expect(writes.join("")).toContain("@halcyon/foo  1 passed (42ms)");
		});

		it("should compose 'pkg › project' when names differ", async () => {
			expect.assertions(2);

			setupHappyPath();
			vi.mocked(runWorkspace).mockResolvedValue([
				{ displayName: "client", pkg: "@halcyon/foo", result: makeExecuteResult() },
				{ displayName: "server", pkg: "@halcyon/foo", result: makeExecuteResult() },
			]);

			const result = await runWorkspaceMode(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
			);

			expect(result.projectResults[0]?.displayName).toBe("@halcyon/foo › client");
			expect(result.projectResults[1]?.displayName).toBe("@halcyon/foo › server");
		});
	});

	describe("workspace.packages enumeration", () => {
		it("should enumerate from workspace.packages without discovering a PM root", async () => {
			expect.assertions(3);

			setupHappyPath();
			vi.mocked(runWorkspace).mockResolvedValue([
				{ displayName: "foo", pkg: "foo", result: makeExecuteResult() },
			]);

			const result = await runWorkspaceMode(makeCli({ packages: "foo", workspace: true }), {
				packages: ["packages/*"],
				root: "/ws",
			});

			expect(result.validationExitCode).toBeUndefined();
			expect(discoverWorkspaceRoot).not.toHaveBeenCalled();
			expect(resolvePackage).toHaveBeenCalledWith("/ws", "foo", ["packages/*"]);
		});

		it("should drive the aggregate sink root off workspace.root", async () => {
			expect.assertions(1);

			setupHappyPath();
			vi.mocked(loadRawConfig).mockResolvedValue({ outputFile: true });
			vi.mocked(runWorkspace).mockResolvedValue([
				{ displayName: "foo", pkg: "foo", result: makeExecuteResult() },
			]);

			const result = await runWorkspaceMode(makeCli({ packages: "foo", workspace: true }), {
				packages: ["packages/*"],
				root: "/ws",
			});

			expect(result.outputFile).toBe(path.join("/ws", "jest-output.log"));
		});
	});

	describe("--affected-since happy path", () => {
		it("should call getAffectedPackages and resolve every name", async () => {
			expect.assertions(3);

			setupHappyPath();
			vi.mocked(getAffectedPackages).mockReturnValue(["@halcyon/foo", "@halcyon/bar"]);
			vi.mocked(runWorkspace).mockResolvedValue([
				{ displayName: "@halcyon/foo", pkg: "@halcyon/foo", result: makeExecuteResult() },
				{ displayName: "@halcyon/bar", pkg: "@halcyon/bar", result: makeExecuteResult() },
			]);

			const result = await runWorkspaceMode(
				makeCli({ affectedSince: "main", workspace: true }),
			);

			expect(result.projectResults).toHaveLength(2);
			expect(getAffectedPackages).toHaveBeenCalledWith("/repo", "main");
			expect(
				vi.mocked(runWorkspace).mock.calls[0]?.[0].packageInfos.map((info) => info.name),
			).toStrictEqual(["@halcyon/foo", "@halcyon/bar"]);
		});

		it("should write a stdout notice and return empty when affected list is empty", async () => {
			expect.assertions(3);

			setupHappyPath();
			vi.mocked(getAffectedPackages).mockReturnValue([]);
			const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			const result = await runWorkspaceMode(
				makeCli({ affectedSince: "main", workspace: true }),
			);

			expect(result.projectResults).toStrictEqual([]);
			expect(result.validationExitCode).toBeUndefined();
			expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("nothing to test"));
		});
	});

	describe("error handling", () => {
		it("should surface discoverWorkspaceRoot errors as validation message", async () => {
			expect.assertions(2);

			setupHappyPath();
			vi.mocked(discoverWorkspaceRoot).mockImplementation(() => {
				throw new Error("No workspace root");
			});

			const result = await runWorkspaceMode(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain("No workspace root");
		});

		it("should surface resolvePackage errors as validation message", async () => {
			expect.assertions(2);

			setupHappyPath();
			vi.mocked(resolvePackage).mockImplementation(() => {
				throw new Error("Package missing");
			});

			const result = await runWorkspaceMode(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain("Package missing");
		});

		it("should surface credentials errors as validation message", async () => {
			expect.assertions(2);

			setupHappyPath();
			vi.mocked(createOpenCloudBackend).mockImplementation(() => {
				throw new Error("missing apiKey");
			});

			const result = await runWorkspaceMode(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain("missing apiKey");
		});

		it("should reject empty --packages list after trimming", async () => {
			expect.assertions(2);

			setupHappyPath();

			const result = await runWorkspaceMode(makeCli({ packages: " , , ", workspace: true }));

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain(
				"--workspace requires --packages or --affected-since",
			);
		});

		it("should return validationExitCode 2 with no message when runWorkspace returns undefined", async () => {
			expect.assertions(3);

			setupHappyPath();
			vi.mocked(runWorkspace).mockResolvedValue(undefined);

			const result = await runWorkspaceMode(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toBeUndefined();
			expect(result.projectResults).toStrictEqual([]);
		});

		it("should close the backend when runWorkspace throws", async () => {
			expect.assertions(2);

			const { backend } = setupHappyPath();
			vi.mocked(runWorkspace).mockRejectedValue(new Error("boom"));

			await expect(
				runWorkspaceMode(makeCli({ packages: "@halcyon/foo", workspace: true })),
			).rejects.toThrow("boom");

			expect(backend.close).toHaveBeenCalledWith();
		});

		it("should surface workspace consensus conflicts as validation message", async () => {
			expect.assertions(2);

			setupHappyPath();
			vi.mocked(loadRawConfig).mockImplementation(async (_configPath, cwd) => {
				return cwd?.endsWith("foo") === true ? { color: true } : { color: false };
			});

			const result = await runWorkspaceMode(
				makeCli({ packages: "@halcyon/foo,@halcyon/bar", workspace: true }),
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain("workspace packages disagree on `color`");
		});

		it("should surface loadRawConfig errors without double-prefixing Error:", async () => {
			expect.assertions(2);

			setupHappyPath();
			vi.mocked(loadRawConfig).mockRejectedValueOnce(new Error("Bad config file"));

			const result = await runWorkspaceMode(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toBe("Error: Bad config file\n");
		});

		it("should stringify non-Error throws from config loading", async () => {
			expect.assertions(2);

			setupHappyPath();
			vi.mocked(loadRawConfig).mockRejectedValueOnce("raw string failure");

			const result = await runWorkspaceMode(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toBe("Error: raw string failure\n");
		});

		it("should stringify non-Error throws from credential building", async () => {
			expect.assertions(2);

			setupHappyPath();
			vi.mocked(createOpenCloudBackend).mockImplementation(() => {
				// eslint-disable-next-line ts/only-throw-error -- exercising the non-Error branch
				throw "raw credential failure";
			});

			const result = await runWorkspaceMode(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
			);

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toBe("Error: raw credential failure\n");
		});
	});

	describe("coverage aggregation", () => {
		it("should aggregate per-package coverage into a single MappedCoverageResult on the result", async () => {
			expect.assertions(2);

			setupHappyPath();
			const manifest = {
				files: {},
				generatedAt: "x",
				instrumenterVersion: 2,
				luauRoots: [],
				nonInstrumentedFiles: {},
				shadowDir: "/shadow",
				version: MANIFEST_VERSION,
			};
			vi.mocked(runWorkspace).mockResolvedValue([
				{
					coverageManifest: manifest,
					displayName: "@halcyon/foo",
					pkg: "@halcyon/foo",
					result: makeExecuteResult({
						coverageData: { "out/foo.luau": { s: { "1": 3 } } },
					}),
				},
			]);

			const { aggregateWorkspaceCoverage } =
				await import("../coverage/workspace-aggregate.ts");
			vi.mocked(aggregateWorkspaceCoverage).mockReturnValue({
				files: {
					"foo.ts": {
						b: {},
						branchMap: {},
						f: {},
						fnMap: {},
						path: "foo.ts",
						s: { "0": 3 },
						statementMap: {
							"0": {
								end: { column: 1, line: 1 },
								start: { column: 0, line: 1 },
							},
						},
					},
				},
			});

			const result = await runWorkspaceMode(
				makeCli({ collectCoverage: true, packages: "@halcyon/foo", workspace: true }),
			);

			expect(aggregateWorkspaceCoverage).toHaveBeenCalledWith([
				expect.objectContaining({
					coverageData: { "out/foo.luau": { s: { "1": 3 } } },
					manifest,
					pkg: "@halcyon/foo",
				}),
			]);
			expect(result.coverageMapped?.files["foo.ts"]).toBeDefined();
		});

		it("should merge raw coverageData across same-pkg multi-project entries and skip pkgs without a manifest", async () => {
			expect.assertions(3);

			setupHappyPath();
			const manifest = {
				files: {},
				generatedAt: "x",
				instrumenterVersion: 2,
				luauRoots: [],
				nonInstrumentedFiles: {},
				shadowDir: "/shadow",
				version: MANIFEST_VERSION,
			};
			vi.mocked(runWorkspace).mockResolvedValue([
				// Two projects under the same pkg — coverageData must MERGE
				// (each project runs Jest with its own _G.__jest_roblox_cov
				// reset, so the maps are disjoint).
				{
					coverageManifest: manifest,
					displayName: "client",
					pkg: "@halcyon/foo",
					result: makeExecuteResult({
						coverageData: { "out/foo.luau": { s: { "1": 3 } } },
					}),
				},
				{
					coverageManifest: manifest,
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

			const { aggregateWorkspaceCoverage } =
				await import("../coverage/workspace-aggregate.ts");
			vi.mocked(aggregateWorkspaceCoverage).mockReturnValue({ files: {} });

			await runWorkspaceMode(
				makeCli({ collectCoverage: true, packages: "@halcyon/foo", workspace: true }),
			);

			const aggregateCall = vi.mocked(aggregateWorkspaceCoverage).mock.calls[0]?.[0];

			expect(aggregateCall).toHaveLength(1);
			expect(aggregateCall?.[0]?.pkg).toBe("@halcyon/foo");
			// 3 + 4 = 7 — both project hits summed.
			expect(aggregateCall?.[0]?.coverageData?.["out/foo.luau"]?.s["1"]).toBe(7);
		});

		it("should leave coverageMapped undefined when the aggregator returns an empty files map", async () => {
			expect.assertions(1);

			setupHappyPath();
			const manifest = {
				files: {},
				generatedAt: "x",
				instrumenterVersion: 2,
				luauRoots: [],
				nonInstrumentedFiles: {},
				shadowDir: "/shadow",
				version: MANIFEST_VERSION,
			};
			vi.mocked(runWorkspace).mockResolvedValue([
				{
					coverageManifest: manifest,
					displayName: "@halcyon/foo",
					pkg: "@halcyon/foo",
					result: makeExecuteResult(),
				},
			]);

			// Empty mapper output means there's nothing to report — the
			// run result should expose `undefined` rather than `{files: {}}`
			// so the formatter's "coverage was empty" warning stays
			// reachable.
			const { aggregateWorkspaceCoverage } =
				await import("../coverage/workspace-aggregate.ts");
			vi.mocked(aggregateWorkspaceCoverage).mockReturnValue({ files: {} });

			const result = await runWorkspaceMode(
				makeCli({ collectCoverage: true, packages: "@halcyon/foo", workspace: true }),
			);

			expect(result.coverageMapped).toBeUndefined();
		});

		it("should not aggregate when no runtime results carry a coverage manifest", async () => {
			expect.assertions(2);

			setupHappyPath();
			vi.mocked(runWorkspace).mockResolvedValue([
				{
					displayName: "@halcyon/foo",
					pkg: "@halcyon/foo",
					result: makeExecuteResult(),
				},
			]);

			const { aggregateWorkspaceCoverage } =
				await import("../coverage/workspace-aggregate.ts");

			const result = await runWorkspaceMode(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
			);

			expect(aggregateWorkspaceCoverage).not.toHaveBeenCalled();
			expect(result.coverageMapped).toBeUndefined();
		});

		it("should aggregate when a runtime result has a coverage manifest even if workspace collectCoverage is false", async () => {
			expect.assertions(1);

			setupHappyPath();
			const manifest = {
				files: {},
				generatedAt: "x",
				instrumenterVersion: 2,
				luauRoots: [],
				nonInstrumentedFiles: {},
				shadowDir: "/shadow",
				version: MANIFEST_VERSION,
			};
			// Per-package opt-in: the workspace runner instrumented foo and
			// attached a manifest. The outer `runWorkspaceMode` must still
			// produce a coverage report instead of gating on the workspace
			// root's `collectCoverage` flag.
			vi.mocked(runWorkspace).mockResolvedValue([
				{
					coverageManifest: manifest,
					displayName: "@halcyon/foo",
					pkg: "@halcyon/foo",
					result: makeExecuteResult({
						coverageData: { "out/foo.luau": { s: { "1": 3 } } },
					}),
				},
			]);

			const { aggregateWorkspaceCoverage } =
				await import("../coverage/workspace-aggregate.ts");
			vi.mocked(aggregateWorkspaceCoverage).mockReturnValue({
				files: {
					"foo.ts": {
						b: {},
						branchMap: {},
						f: {},
						fnMap: {},
						path: "foo.ts",
						s: { "0": 3 },
						statementMap: {
							"0": {
								end: { column: 1, line: 1 },
								start: { column: 0, line: 1 },
							},
						},
					},
				},
			});

			const result = await runWorkspaceMode(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
			);

			expect(result.coverageMapped?.files["foo.ts"]).toBeDefined();
		});
	});

	describe("empty results", () => {
		it("should return empty projectResults when runWorkspace returns []", async () => {
			expect.assertions(2);

			setupHappyPath();
			vi.mocked(runWorkspace).mockResolvedValue([]);

			const result = await runWorkspaceMode(
				makeCli({ packages: "@halcyon/foo", workspace: true }),
			);

			expect(result.validationExitCode).toBeUndefined();
			expect(result.projectResults).toStrictEqual([]);
		});
	});
});
