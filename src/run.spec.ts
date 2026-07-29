import { describe, expect, it, vi } from "vitest";

import { type CliOptions, DEFAULT_CONFIG, type ResolvedConfig } from "./config/schema.ts";
import type { CoverageArtifacts } from "./coverage-pipeline/build-manifest.ts";
import { emitBuildManifest } from "./coverage-pipeline/build-manifest.ts";
import { COVERAGE_BUILD_MANIFEST_PATH } from "./coverage-pipeline/prepare.ts";
import { runJestRobloxAsync } from "./run.ts";
import { loadRojoTree, runMultiProjectAsync, runResolvedProjectsAsync } from "./run/multi.ts";
import type { MultiRunResult, WorkspaceRunResult } from "./run/types.ts";
import { runWorkspaceModeAsync } from "./run/workspace.ts";

vi.mock(import("./run/multi"));
// `loadRojoTree` + `buildImplicitProject` are auto-mocked here so the collapse
// path resolves to the `runResolvedProjects` mock without touching real Rojo.
vi.mock(import("./run/single-projects"));
vi.mock(import("./run/workspace"));
vi.mock(import("./coverage-pipeline/build-manifest"));

const mocks = {
	emitBuildManifest: vi.mocked(emitBuildManifest),
	loadRojoTree: vi.mocked(loadRojoTree),
	runMultiProject: vi.mocked(runMultiProjectAsync),
	runResolvedProjects: vi.mocked(runResolvedProjectsAsync),
	runWorkspaceMode: vi.mocked(runWorkspaceModeAsync),
};

const COVERAGE_ARTIFACTS: CoverageArtifacts = {
	buildId: "build-1",
	coveragePlace: { hash: "cov-hash", path: ".jest-roblox/coverage/game.rbxl" },
	files: {},
	generatedAt: "2026-06-07T00:00:00.000Z",
	projects: [],
	rebuilt: true,
};

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
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
	merged: {},
	mode: "multi",
	preCoverageMs: 0,
	projectResults: [],
};
const WORKSPACE: WorkspaceRunResult = {
	merged: {},
	mode: "workspace",
	preCoverageMs: 0,
	projectResults: [],
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

		// `projects` still holds raw `ProjectEntry` objects at dispatch time,
		// which `ResolvedConfig` types as `Array<string>` post-resolution.
		const config = makeConfig();
		Reflect.set(config, "projects", [{ projects: ["client"] }]);

		const result = await runJestRobloxAsync(makeCli(), config);

		expect(result).toBe(MULTI);
		expect(mocks.runMultiProject).toHaveBeenCalledOnce();
	});

	it("should collapse a no-projects runtime run into runResolvedProjects", async () => {
		expect.assertions(3);

		mocks.runResolvedProjects.mockResolvedValue(MULTI);

		const result = await runJestRobloxAsync(makeCli(), makeConfig());

		expect(result).toBe(MULTI);
		expect(mocks.runResolvedProjects).toHaveBeenCalledOnce();
		expect(mocks.loadRojoTree).toHaveBeenCalledOnce();
	});

	it("should collapse to runResolvedProjects when config.projects is an empty array", async () => {
		expect.assertions(1);

		mocks.runResolvedProjects.mockResolvedValue(MULTI);

		const config = makeConfig();
		Reflect.set(config, "projects", []);

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
