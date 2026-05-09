import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import type { Backend, BackendOptions, BackendResult } from "../backends/interface.ts";
import { createOpenCloudBackend } from "../backends/open-cloud.ts";
import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { ExecuteResult } from "../executor.ts";
import type { JestResult } from "../types/jest-result.ts";
import { runWorkspace } from "../workspace-runner.ts";
import { getAffectedPackages } from "../workspace/affected.ts";
import { discoverWorkspaceRoot } from "../workspace/discovery.ts";
import { resolvePackage } from "../workspace/package-resolver.ts";
import { runWorkspaceMode } from "./workspace.ts";

vi.mock(import("../workspace-runner.ts"));
vi.mock(import("../workspace/discovery.ts"));
vi.mock(import("../workspace/package-resolver.ts"));
vi.mock(import("../workspace/affected.ts"));
vi.mock(import("../backends/open-cloud.ts"));
vi.mock(import("../memory-store/queue-client.ts"), () => {
	return fromAny({ MemoryStoreQueueClient: vi.fn<() => unknown>() });
});
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
	return { ...overrides };
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...DEFAULT_CONFIG, backend: "open-cloud", ...overrides };
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
			uploadCached: false,
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
			return { results: [], timing: { executionMs: 0 } };
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
	return { backend };
}

describe(runWorkspaceMode, () => {
	describe("validation", () => {
		it("should surface mutually-exclusive --packages/--affected-since failure", async () => {
			expect.assertions(2);

			setupHappyPath();
			const result = await runWorkspaceMode({
				cli: makeCli({ affectedSince: "main", packages: "a", workspace: true }),
				config: makeConfig(),
			});

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain(
				"--packages and --affected-since are mutually exclusive",
			);
		});

		it("should surface missing --packages/--affected-since failure", async () => {
			expect.assertions(2);

			setupHappyPath();
			const result = await runWorkspaceMode({
				cli: makeCli({ workspace: true }),
				config: makeConfig(),
			});

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain(
				"--workspace requires --packages or --affected-since",
			);
		});

		it("should surface coverage-with-workspace failure", async () => {
			expect.assertions(2);

			setupHappyPath();
			const result = await runWorkspaceMode({
				cli: makeCli({ collectCoverage: true, packages: "a", workspace: true }),
				config: makeConfig({ collectCoverage: true }),
			});

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain("coverage not supported with --workspace");
		});

		it("should surface gameOutput-with-workspace failure", async () => {
			expect.assertions(2);

			setupHappyPath();
			const result = await runWorkspaceMode({
				cli: makeCli({ gameOutput: "/tmp/x", packages: "a", workspace: true }),
				config: makeConfig({ gameOutput: "/tmp/x" }),
			});

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain(
				"--gameOutput not yet supported with --workspace",
			);
		});

		it("should surface studio-backend-with-workspace failure", async () => {
			expect.assertions(2);

			setupHappyPath();
			const result = await runWorkspaceMode({
				cli: makeCli({ packages: "a", workspace: true }),
				config: makeConfig({ backend: "studio" }),
			});

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

			const result = await runWorkspaceMode({
				cli: makeCli({ packages: "@halcyon/foo,@halcyon/bar", workspace: true }),
				config: makeConfig(),
			});

			expect(result.validationExitCode).toBeUndefined();
			expect(result.projectResults).toHaveLength(2);
			expect(
				vi.mocked(runWorkspace).mock.calls[0]?.[0].packageInfos.map((info) => info.name),
			).toStrictEqual(["@halcyon/foo", "@halcyon/bar"]);
		});

		it("should collapse displayName when project name matches package name", async () => {
			expect.assertions(1);

			setupHappyPath();
			vi.mocked(runWorkspace).mockResolvedValue([
				{ displayName: "@halcyon/foo", pkg: "@halcyon/foo", result: makeExecuteResult() },
			]);

			const result = await runWorkspaceMode({
				cli: makeCli({ packages: "@halcyon/foo", workspace: true }),
				config: makeConfig(),
			});

			expect(result.projectResults[0]?.displayName).toBe("@halcyon/foo");
		});

		it("should compose 'pkg › project' when names differ", async () => {
			expect.assertions(2);

			setupHappyPath();
			vi.mocked(runWorkspace).mockResolvedValue([
				{ displayName: "client", pkg: "@halcyon/foo", result: makeExecuteResult() },
				{ displayName: "server", pkg: "@halcyon/foo", result: makeExecuteResult() },
			]);

			const result = await runWorkspaceMode({
				cli: makeCli({ packages: "@halcyon/foo", workspace: true }),
				config: makeConfig(),
			});

			expect(result.projectResults[0]?.displayName).toBe("@halcyon/foo › client");
			expect(result.projectResults[1]?.displayName).toBe("@halcyon/foo › server");
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

			const result = await runWorkspaceMode({
				cli: makeCli({ affectedSince: "main", workspace: true }),
				config: makeConfig(),
			});

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

			const result = await runWorkspaceMode({
				cli: makeCli({ affectedSince: "main", workspace: true }),
				config: makeConfig(),
			});

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

			const result = await runWorkspaceMode({
				cli: makeCli({ packages: "@halcyon/foo", workspace: true }),
				config: makeConfig(),
			});

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain("No workspace root");
		});

		it("should surface resolvePackage errors as validation message", async () => {
			expect.assertions(2);

			setupHappyPath();
			vi.mocked(resolvePackage).mockImplementation(() => {
				throw new Error("Package missing");
			});

			const result = await runWorkspaceMode({
				cli: makeCli({ packages: "@halcyon/foo", workspace: true }),
				config: makeConfig(),
			});

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain("Package missing");
		});

		it("should surface credentials errors as validation message", async () => {
			expect.assertions(2);

			setupHappyPath();
			vi.mocked(createOpenCloudBackend).mockImplementation(() => {
				throw new Error("missing apiKey");
			});

			const result = await runWorkspaceMode({
				cli: makeCli({ packages: "@halcyon/foo", workspace: true }),
				config: makeConfig(),
			});

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain("missing apiKey");
		});

		it("should reject empty --packages list after trimming", async () => {
			expect.assertions(2);

			setupHappyPath();

			const result = await runWorkspaceMode({
				cli: makeCli({ packages: " , , ", workspace: true }),
				config: makeConfig(),
			});

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toContain(
				"--workspace requires --packages or --affected-since",
			);
		});

		it("should return validationExitCode 2 with no message when runWorkspace returns undefined", async () => {
			expect.assertions(3);

			setupHappyPath();
			vi.mocked(runWorkspace).mockResolvedValue(undefined);

			const result = await runWorkspaceMode({
				cli: makeCli({ packages: "@halcyon/foo", workspace: true }),
				config: makeConfig(),
			});

			expect(result.validationExitCode).toBe(2);
			expect(result.validationMessage).toBeUndefined();
			expect(result.projectResults).toStrictEqual([]);
		});

		it("should close the backend when runWorkspace throws", async () => {
			expect.assertions(2);

			const { backend } = setupHappyPath();
			vi.mocked(runWorkspace).mockRejectedValue(new Error("boom"));

			await expect(
				runWorkspaceMode({
					cli: makeCli({ packages: "@halcyon/foo", workspace: true }),
					config: makeConfig(),
				}),
			).rejects.toThrow("boom");

			expect(backend.close).toHaveBeenCalledWith();
		});
	});

	describe("empty results", () => {
		it("should return empty projectResults when runWorkspace returns []", async () => {
			expect.assertions(2);

			setupHappyPath();
			vi.mocked(runWorkspace).mockResolvedValue([]);

			const result = await runWorkspaceMode({
				cli: makeCli({ packages: "@halcyon/foo", workspace: true }),
				config: makeConfig(),
			});

			expect(result.validationExitCode).toBeUndefined();
			expect(result.projectResults).toStrictEqual([]);
		});
	});
});
