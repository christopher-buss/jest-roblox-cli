import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import { resolveAllProjects } from "../config/projects.ts";
import { DEFAULT_CONFIG, type ResolvedConfig } from "../config/schema.ts";
import { generateProjectStubs } from "../config/stubs.ts";
import type { CoverageArtifacts } from "../coverage-pipeline/build-manifest.ts";
import { emitBuildManifest } from "../coverage-pipeline/build-manifest.ts";
import {
	COVERAGE_BUILD_MANIFEST_PATH,
	COVERAGE_MANIFEST_PATH,
} from "../coverage-pipeline/prepare.ts";
import { getRawProjects } from "../run.ts";
import { loadRojoTree, prepareBakedCoverage } from "../run/multi.ts";
import { buildImplicitProject } from "../run/single-projects.ts";
import { buildCoveragePlace } from "./build-coverage-place.ts";

vi.mock(import("../run.ts"));
vi.mock(import("../run/multi.ts"));
vi.mock(import("../run/single-projects.ts"));
vi.mock(import("../config/projects.ts"));
vi.mock(import("../config/stubs.ts"));
vi.mock(import("../coverage-pipeline/build-manifest.ts"));

const mocks = {
	buildImplicitProject: vi.mocked(buildImplicitProject),
	emitBuildManifest: vi.mocked(emitBuildManifest),
	generateProjectStubs: vi.mocked(generateProjectStubs),
	getRawProjects: vi.mocked(getRawProjects),
	loadRojoTree: vi.mocked(loadRojoTree),
	prepareBakedCoverage: vi.mocked(prepareBakedCoverage),
	resolveAllProjects: vi.mocked(resolveAllProjects),
};

const COVERAGE_PLACE = { hash: "cov-hash", path: ".jest-roblox/coverage/game.rbxl" };

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...DEFAULT_CONFIG,
		rootDir: "/test",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

function makeArtifacts(overrides: Partial<CoverageArtifacts> = {}): CoverageArtifacts {
	return {
		buildId: "build-77",
		coveragePlace: COVERAGE_PLACE,
		files: {},
		generatedAt: "2026-06-07T00:00:00.000Z",
		projects: [],
		rebuilt: true,
		...overrides,
	};
}

function primeHappyPath(artifacts = makeArtifacts()): void {
	mocks.loadRojoTree.mockReturnValue(fromAny({ $className: "DataModel" }));
	mocks.buildImplicitProject.mockReturnValue(fromAny({ displayName: "test", rojoMounts: [] }));
	mocks.prepareBakedCoverage.mockReturnValue({ artifacts, coverage: fromAny({}) });
}

describe(buildCoveragePlace, () => {
	it("should return the coverage place, build id, and manifest paths", async () => {
		expect.assertions(4);

		primeHappyPath();

		const bundle = await buildCoveragePlace(makeConfig());

		expect(bundle.coveragePlace).toStrictEqual(COVERAGE_PLACE);
		expect(bundle.buildId).toBe("build-77");
		expect(bundle.buildManifestPath).toBe(COVERAGE_BUILD_MANIFEST_PATH);
		expect(bundle.coverageManifestPath).toBe(COVERAGE_MANIFEST_PATH);
	});

	it("should force coverage collection on regardless of the input config", async () => {
		expect.assertions(1);

		primeHappyPath();

		await buildCoveragePlace(makeConfig({ collectCoverage: false }));

		expect(mocks.prepareBakedCoverage.mock.calls[0]![0].collectCoverage).toBeTrue();
	});

	it("should emit the build manifest with the coverage place and no clean place", async () => {
		expect.assertions(1);

		const artifacts = makeArtifacts();
		primeHappyPath(artifacts);

		await buildCoveragePlace(makeConfig());

		expect(mocks.emitBuildManifest.mock.calls[0]).toStrictEqual([
			COVERAGE_BUILD_MANIFEST_PATH,
			artifacts,
		]);
	});

	it("should always bake jest.config stubs so the place is self-contained", async () => {
		expect.assertions(2);

		primeHappyPath();

		await buildCoveragePlace(makeConfig());

		expect(mocks.generateProjectStubs).toHaveBeenCalledOnce();
		// The 4th arg to prepareBakedCoverage is `bakeStubs` — always true here.
		expect(mocks.prepareBakedCoverage.mock.calls[0]![3]).toBeTrue();
	});

	it("should resolve the implicit project when the config declares no projects", async () => {
		expect.assertions(2);

		primeHappyPath();
		mocks.getRawProjects.mockReturnValue(undefined);

		await buildCoveragePlace(makeConfig());

		expect(mocks.buildImplicitProject).toHaveBeenCalledOnce();
		expect(mocks.resolveAllProjects).not.toHaveBeenCalled();
	});

	it("should resolve declared projects in multi mode", async () => {
		expect.assertions(2);

		primeHappyPath();
		mocks.getRawProjects.mockReturnValue(fromAny([{ test: { displayName: "c" } }]));
		mocks.resolveAllProjects.mockResolvedValue([fromAny({ displayName: "c", rojoMounts: [] })]);

		await buildCoveragePlace(makeConfig());

		expect(mocks.resolveAllProjects).toHaveBeenCalledOnce();
		expect(mocks.buildImplicitProject).not.toHaveBeenCalled();
	});

	it("should not rewrite the build manifest on the incremental no-change reuse path", async () => {
		expect.assertions(2);

		primeHappyPath(makeArtifacts({ rebuilt: false }));

		const bundle = await buildCoveragePlace(makeConfig());

		expect(mocks.emitBuildManifest).not.toHaveBeenCalled();
		expect(bundle.rebuilt).toBeFalse();
	});
});
