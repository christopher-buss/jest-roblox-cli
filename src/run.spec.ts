import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import { type CliOptions, DEFAULT_CONFIG, type ResolvedConfig } from "./config/schema.ts";
import type { CoverageArtifacts } from "./coverage-pipeline/build-manifest.ts";
import { emitBuildManifest } from "./coverage-pipeline/build-manifest.ts";
import { COVERAGE_BUILD_MANIFEST_PATH } from "./coverage-pipeline/prepare.ts";
import { runJestRobloxAsync } from "./run.ts";
import { loadRojoTree, runMultiProjectAsync, runResolvedProjectsAsync } from "./run/multi.ts";
import type { MultiRunResult, WorkspaceRunResult } from "./run/types.ts";
import { runWorkspaceModeAsync } from "./run/workspace.ts";
import { createTimingCollector } from "./timing/orchestration-collector.ts";

vi.mock(import("./run/multi"));
// `loadRojoTree` + `buildImplicitProject` are auto-mocked here so the collapse
// path resolves to the `runResolvedProjects` mock without touching real Rojo.
vi.mock(import("./run/single-projects"));
vi.mock(import("./run/workspace"));
vi.mock(import("./coverage-pipeline/build-manifest"));
vi.mock(import("./timing/orchestration-collector"));

const mocks = {
	emitBuildManifest: vi.mocked(emitBuildManifest),
	loadRojoTree: vi.mocked(loadRojoTree),
	runMultiProject: vi.mocked(runMultiProjectAsync),
	runResolvedProjects: vi.mocked(runResolvedProjectsAsync),
	runWorkspaceMode: vi.mocked(runWorkspaceModeAsync),
};

const flushTimingReport = vi.fn<() => void>();
const profile = vi.fn<(label: string, callback: () => unknown) => unknown>((_, callback) => {
	return callback();
});

const COVERAGE_ARTIFACTS: CoverageArtifacts = {
	buildId: "build-1",
	coveragePlace: { hash: "cov-hash", path: ".jest-roblox/coverage/game.rbxl" },
	files: {},
	generatedAt: "2026-06-07T00:00:00.000Z",
	projects: [],
	rebuilt: true,
};

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	vi.mocked(createTimingCollector).mockReturnValue(
		fromAny({
			flushTimingReport,
			profile,
			profileAsync:
				vi.fn<(label: string, callback: () => Promise<unknown>) => Promise<unknown>>(),
		}),
	);
	return {
		...DEFAULT_CONFIG,
		rootDir: "/test",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

function makeCli(overrides: Partial<CliOptions> = {}): CliOptions {
	return { ...overrides };
}

const MULTI: MultiRunResult = {
	coverageMs: 0,
	merged: {},
	mode: "multi",
	projectResults: [],
	stagingMs: 0,
};
const WORKSPACE: WorkspaceRunResult = {
	coverageMs: 0,
	merged: {},
	mode: "workspace",
	projectResults: [],
	stagingMs: 0,
};

describe(runJestRobloxAsync, () => {
	it("should dispatch to runWorkspaceMode when --workspace is set", async () => {
		expect.assertions(2);

		mocks.runWorkspaceMode.mockResolvedValue(WORKSPACE);

		const result = await runJestRobloxAsync(makeCli({ workspace: true }), makeConfig());

		expect(result).toBe(WORKSPACE);
		expect(mocks.runWorkspaceMode).toHaveBeenCalledOnce();
	});

	it("should dispatch to runWorkspaceMode when --packages is set", async () => {
		expect.assertions(1);

		mocks.runWorkspaceMode.mockResolvedValue(WORKSPACE);

		await runJestRobloxAsync(makeCli({ packages: "foo,bar" }), makeConfig());

		expect(mocks.runWorkspaceMode).toHaveBeenCalledOnce();
	});

	it("should dispatch to runWorkspaceMode when --affected-since is set", async () => {
		expect.assertions(1);

		mocks.runWorkspaceMode.mockResolvedValue(WORKSPACE);

		await runJestRobloxAsync(makeCli({ affectedSince: "main" }), makeConfig());

		expect(mocks.runWorkspaceMode).toHaveBeenCalledOnce();
	});

	it("should dispatch to runMultiProject when config.projects is non-empty", async () => {
		expect.assertions(2);

		mocks.runMultiProject.mockResolvedValue(MULTI);

		const config = makeConfig({
			projects: [{ test: { displayName: "client", include: ["a.spec.ts"] } }],
		});

		const result = await runJestRobloxAsync(makeCli(), config);

		expect(result).toBe(MULTI);
		expect(mocks.runMultiProject).toHaveBeenCalledOnce();
	});

	it("should collapse a no-projects runtime run into runResolvedProjects", async () => {
		expect.assertions(5);

		mocks.runResolvedProjects.mockResolvedValue(MULTI);

		await runJestRobloxAsync(makeCli(), makeConfig());

		expect(mocks.runResolvedProjects).toHaveBeenCalledExactlyOnceWith(
			[undefined],
			expect.anything(),
			expect.anything(),
		);
		expect(mocks.loadRojoTree).toHaveBeenCalledOnce();
		expect(profile).toHaveBeenCalledWith("loadRojoTree", expect.any(Function));
		expect(flushTimingReport).toHaveBeenCalledOnce();
		expect(mocks.runResolvedProjects.mock.calls[0]![0]).toHaveLength(1);
	});

	it("should flush timing when workspace execution rejects", async () => {
		expect.assertions(2);

		const error = new Error("workspace failed");
		mocks.runWorkspaceMode.mockRejectedValue(error);

		await expect(runJestRobloxAsync(makeCli({ workspace: true }), makeConfig())).rejects.toBe(
			error,
		);
		expect(flushTimingReport).toHaveBeenCalledOnce();
	});

	it("should collapse to runResolvedProjects when config.projects is an empty array", async () => {
		expect.assertions(1);

		mocks.runResolvedProjects.mockResolvedValue(MULTI);

		const config = makeConfig({ projects: [] });

		await runJestRobloxAsync(makeCli(), config);

		expect(mocks.runResolvedProjects).toHaveBeenCalledOnce();
	});

	// `--typecheckOnly` is pure-local tsgo, so the collapse must not require a
	// Rojo project on disk: the tree is never loaded and the implicit project is
	// built mountless.
	it("should collapse a typecheck-only no-projects run without loading a Rojo tree", async () => {
		expect.assertions(3);

		mocks.runResolvedProjects.mockResolvedValue(MULTI);

		const result = await runJestRobloxAsync(makeCli({ typecheckOnly: true }), makeConfig());

		expect(result).toBe(MULTI);
		expect(mocks.runResolvedProjects).toHaveBeenCalledOnce();
		expect(mocks.loadRojoTree).not.toHaveBeenCalled();
	});

	it("should pass cli through to workspace mode without merging workspace-root config", async () => {
		expect.assertions(1);

		mocks.runWorkspaceMode.mockResolvedValue(WORKSPACE);

		const cli = makeCli({ collectCoverage: true, packages: "a", workspace: true });
		await runJestRobloxAsync(cli, makeConfig({ collectCoverage: false }));

		const [forwardedCli] = mocks.runWorkspaceMode.mock.calls[0]!;

		expect(forwardedCli).toBe(cli);
	});

	it("should forward config.workspace to workspace mode for enumeration", async () => {
		expect.assertions(1);

		mocks.runWorkspaceMode.mockResolvedValue(WORKSPACE);

		const config = makeConfig({ workspace: { packages: ["packages/*"], root: "/ws" } });
		await runJestRobloxAsync(makeCli({ packages: "foo", workspace: true }), config);

		const [, forwardedWorkspace] = mocks.runWorkspaceMode.mock.calls[0]!;

		expect(forwardedWorkspace).toStrictEqual({ packages: ["packages/*"], root: "/ws" });
	});

	it("should emit a coveragePlace-only build manifest on a rebuilt coverage run", async () => {
		expect.assertions(1);

		mocks.runResolvedProjects.mockResolvedValue({
			...MULTI,
			coverageArtifacts: COVERAGE_ARTIFACTS,
		});

		await runJestRobloxAsync(makeCli(), makeConfig());

		expect(mocks.emitBuildManifest).toHaveBeenCalledWith(
			COVERAGE_BUILD_MANIFEST_PATH,
			COVERAGE_ARTIFACTS,
		);
	});

	it("should not emit a build manifest when the coverage place was reused", async () => {
		expect.assertions(1);

		mocks.runResolvedProjects.mockResolvedValue({
			...MULTI,
			coverageArtifacts: { ...COVERAGE_ARTIFACTS, rebuilt: false },
		});

		await runJestRobloxAsync(makeCli(), makeConfig());

		expect(mocks.emitBuildManifest).not.toHaveBeenCalled();
	});

	it("should not emit a build manifest for a non-coverage run", async () => {
		expect.assertions(1);

		mocks.runResolvedProjects.mockResolvedValue(MULTI);

		await runJestRobloxAsync(makeCli(), makeConfig());

		expect(mocks.emitBuildManifest).not.toHaveBeenCalled();
	});
});
