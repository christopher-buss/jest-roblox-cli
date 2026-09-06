import { fromAny } from "@total-typescript/shoehorn";

import process from "node:process";
import type { MockInstance } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type { MemoryVolume } from "../test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "../test/mocks/memory-file-system.ts";
import type { ResolvedProjectConfig } from "./config/projects.ts";
import { type CliOptions, DEFAULT_CONFIG, type ResolvedConfig } from "./config/schema.ts";
import type { CoverageArtifacts } from "./coverage-pipeline/build-manifest.ts";
import { COVERAGE_BUILD_MANIFEST_PATH } from "./coverage-pipeline/prepare.ts";
import type { RunDispatch } from "./run.ts";
import { runJestRobloxAsync } from "./run.ts";
import type { RunSeams } from "./run/seams.ts";
import { nodeRunSeams } from "./run/seams.ts";
import type { MultiRunResult, WorkspaceRunResult } from "./run/types.ts";
import type { ChildProcessRunner } from "./utils/child-process.ts";

const COVERAGE_ARTIFACTS: CoverageArtifacts = {
	buildId: "build-1",
	coveragePlace: { hash: "cov-hash", path: ".jest-roblox/coverage/game.rbxl" },
	files: {},
	generatedAt: "2026-06-07T00:00:00.000Z",
	projects: [],
	rebuilt: true,
};

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

const IMPLICIT_PROJECT: ResolvedProjectConfig = fromAny({ displayName: "implicit" });

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

function makeDispatch(): RunDispatch {
	return {
		buildImplicitProject: vi
			.fn<RunDispatch["buildImplicitProject"]>()
			.mockReturnValue(IMPLICIT_PROJECT),
		loadRojoTree: vi
			.fn<RunDispatch["loadRojoTree"]>()
			.mockReturnValue(fromAny({ $className: "DataModel" })),
		runMultiProject: vi.fn<RunDispatch["runMultiProject"]>().mockResolvedValue(MULTI),
		runResolvedProjects: vi.fn<RunDispatch["runResolvedProjects"]>().mockResolvedValue(MULTI),
		runWorkspaceMode: vi.fn<RunDispatch["runWorkspaceMode"]>().mockResolvedValue(WORKSPACE),
	};
}

function captureTimingReport(): MockInstance<typeof process.stderr.write> {
	vi.stubEnv("TIMING", "1");
	return vi.spyOn(process.stderr, "write").mockReturnValue(true);
}

function readBuildManifest(volume: MemoryVolume): {
	cleanPlace?: unknown;
	coveragePlace: unknown;
} {
	return fromAny(JSON.parse(String(volume.readFileSync(COVERAGE_BUILD_MANIFEST_PATH, "utf8"))));
}

function timingLines(stderr: MockInstance<typeof process.stderr.write>): Array<string> {
	return stderr.mock.calls.map(([line]) => String(line));
}

describe(runJestRobloxAsync, () => {
	it("should dispatch to runWorkspaceMode when --workspace is set", async () => {
		expect.assertions(2);

		const dispatch = makeDispatch();

		const result = await runJestRobloxAsync(
			makeCli({ workspace: true }),
			makeConfig(),
			undefined,
			{
				dispatch,
			},
		);

		expect(result).toBe(WORKSPACE);
		expect(dispatch.runWorkspaceMode).toHaveBeenCalledOnce();
	});

	it("should dispatch to runWorkspaceMode when --packages is set", async () => {
		expect.assertions(1);

		const dispatch = makeDispatch();

		await runJestRobloxAsync(makeCli({ packages: "foo,bar" }), makeConfig(), undefined, {
			dispatch,
		});

		expect(dispatch.runWorkspaceMode).toHaveBeenCalledOnce();
	});

	it("should dispatch to runWorkspaceMode when --affected-since is set", async () => {
		expect.assertions(1);

		const dispatch = makeDispatch();

		await runJestRobloxAsync(makeCli({ affectedSince: "main" }), makeConfig(), undefined, {
			dispatch,
		});

		expect(dispatch.runWorkspaceMode).toHaveBeenCalledOnce();
	});

	it("should dispatch to runMultiProject when config.projects is non-empty", async () => {
		expect.assertions(2);

		const dispatch = makeDispatch();
		const config = makeConfig({
			projects: [{ test: { displayName: "client", include: ["a.spec.ts"] } }],
		});

		const result = await runJestRobloxAsync(makeCli(), config, undefined, { dispatch });

		expect(result).toBe(MULTI);
		expect(dispatch.runMultiProject).toHaveBeenCalledOnce();
	});

	it("should collapse a no-projects runtime run into runResolvedProjects", async () => {
		expect.assertions(4);

		const dispatch = makeDispatch();
		const stderr = captureTimingReport();

		await runJestRobloxAsync(makeCli(), makeConfig(), undefined, { dispatch });

		expect(dispatch.runResolvedProjects).toHaveBeenCalledExactlyOnceWith(
			[IMPLICIT_PROJECT],
			expect.anything(),
			expect.anything(),
		);
		expect(dispatch.loadRojoTree).toHaveBeenCalledOnce();
		expect(timingLines(stderr)).toContain("[TIMING] loadRojoTree: start\n");
		expect(timingLines(stderr).at(-1)).toContain("TOTAL (host)");
	});

	it("should give the collapse path the run's own filesystem", async () => {
		expect.assertions(2);

		const dispatch = makeDispatch();
		const { fileSystem } = createMemoryFileSystem();

		await runJestRobloxAsync(makeCli(), makeConfig(), undefined, { dispatch, fileSystem });

		expect(dispatch.loadRojoTree).toHaveBeenCalledWith(expect.anything(), fileSystem);
		expect(dispatch.buildImplicitProject).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ fileSystem }),
		);
	});

	it("should hand workspace mode the run's own filesystem and launcher", async () => {
		expect.assertions(1);

		const dispatch = makeDispatch();
		const { fileSystem } = createMemoryFileSystem();
		const childProcess: ChildProcessRunner = fromAny({
			execFileSync: vi.fn<ChildProcessRunner["execFileSync"]>(),
		});

		await runJestRobloxAsync(makeCli({ workspace: true }), makeConfig(), undefined, {
			dispatch,
			fileSystem,
			seams: { ...nodeRunSeams(), childProcess },
		});

		const forwarded = vi.mocked(dispatch.runWorkspaceMode).mock.calls[0]![3];

		expect(forwarded).toStrictEqual({ childProcess, fileSystem });
	});

	it("should flush timing when workspace execution rejects", async () => {
		expect.assertions(2);

		const dispatch = makeDispatch();
		const error = new Error("workspace failed");
		vi.mocked(dispatch.runWorkspaceMode).mockImplementation(
			async (_cli, _workspace, timing) => {
				timing!.profile("enumeratePackages", () => {});
				throw error;
			},
		);
		const stderr = captureTimingReport();

		await expect(
			runJestRobloxAsync(makeCli({ workspace: true }), makeConfig(), undefined, { dispatch }),
		).rejects.toBe(error);
		expect(timingLines(stderr).at(-1)).toContain("TOTAL (host)");
	});

	it("should collapse to runResolvedProjects when config.projects is an empty array", async () => {
		expect.assertions(1);

		const dispatch = makeDispatch();

		await runJestRobloxAsync(makeCli(), makeConfig({ projects: [] }), undefined, { dispatch });

		expect(dispatch.runResolvedProjects).toHaveBeenCalledOnce();
	});

	// `--typecheckOnly` is pure-local tsgo, so the collapse must not require a
	// Rojo project on disk: the tree is never loaded and the implicit project is
	// built mountless.
	it("should collapse a typecheck-only no-projects run without loading a Rojo tree", async () => {
		expect.assertions(3);

		const dispatch = makeDispatch();

		const result = await runJestRobloxAsync(
			makeCli({ typecheckOnly: true }),
			makeConfig(),
			undefined,
			{ dispatch },
		);

		expect(result).toBe(MULTI);
		expect(dispatch.runResolvedProjects).toHaveBeenCalledOnce();
		expect(dispatch.loadRojoTree).not.toHaveBeenCalled();
	});

	it("should resolve the real run paths when no dispatch is handed in", async () => {
		expect.assertions(2);

		const runTypecheck = vi.fn<RunSeams["runTypecheck"]>();
		const { fileSystem } = createMemoryFileSystem();

		const result = await runJestRobloxAsync(
			makeCli({ typecheckOnly: true }),
			makeConfig({ passWithNoTests: true }),
			undefined,
			{ fileSystem, seams: { ...nodeRunSeams(), runTypecheck } },
		);

		expect(result.mode).toBe("multi");
		expect(result.projectResults).toBeEmpty();
	});

	it("should pass cli through to workspace mode without merging workspace-root config", async () => {
		expect.assertions(1);

		const dispatch = makeDispatch();
		const cli = makeCli({ collectCoverage: true, packages: "a", workspace: true });

		await runJestRobloxAsync(cli, makeConfig({ collectCoverage: false }), undefined, {
			dispatch,
		});

		const [forwardedCli] = vi.mocked(dispatch.runWorkspaceMode).mock.calls[0]!;

		expect(forwardedCli).toBe(cli);
	});

	it("should forward config.workspace to workspace mode for enumeration", async () => {
		expect.assertions(1);

		const dispatch = makeDispatch();
		const config = makeConfig({ workspace: { packages: ["packages/*"], root: "/ws" } });

		await runJestRobloxAsync(makeCli({ packages: "foo", workspace: true }), config, undefined, {
			dispatch,
		});

		const [, forwardedWorkspace] = vi.mocked(dispatch.runWorkspaceMode).mock.calls[0]!;

		expect(forwardedWorkspace).toStrictEqual({ packages: ["packages/*"], root: "/ws" });
	});

	it("should emit a coveragePlace-only build manifest on a rebuilt coverage run", async () => {
		expect.assertions(2);

		const dispatch = makeDispatch();
		vi.mocked(dispatch.runResolvedProjects).mockResolvedValue({
			...MULTI,
			coverageArtifacts: COVERAGE_ARTIFACTS,
		});
		const { fileSystem, volume } = createMemoryFileSystem();

		await runJestRobloxAsync(makeCli(), makeConfig(), undefined, { dispatch, fileSystem });

		const manifest = readBuildManifest(volume);

		expect(manifest.coveragePlace).toStrictEqual(COVERAGE_ARTIFACTS.coveragePlace);
		expect(manifest.cleanPlace).toBeUndefined();
	});

	it("should not emit a build manifest when the coverage place was reused", async () => {
		expect.assertions(1);

		const dispatch = makeDispatch();
		vi.mocked(dispatch.runResolvedProjects).mockResolvedValue({
			...MULTI,
			coverageArtifacts: { ...COVERAGE_ARTIFACTS, rebuilt: false },
		});
		const { fileSystem, volume } = createMemoryFileSystem();

		await runJestRobloxAsync(makeCli(), makeConfig(), undefined, { dispatch, fileSystem });

		expect(volume.existsSync(COVERAGE_BUILD_MANIFEST_PATH)).toBeFalse();
	});

	it("should not emit a build manifest for a non-coverage run", async () => {
		expect.assertions(1);

		const dispatch = makeDispatch();
		const { fileSystem, volume } = createMemoryFileSystem();

		await runJestRobloxAsync(makeCli(), makeConfig(), undefined, { dispatch, fileSystem });

		expect(volume.existsSync(COVERAGE_BUILD_MANIFEST_PATH)).toBeFalse();
	});
});
