import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { clockTimingCollector } from "#test/mocks/clock-timing-collector.ts";
import { fakeTimingCollector, phaseNamesOf } from "#test/mocks/fake-timing-collector.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { createRunSeams } from "#test/mocks/run-seams.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { PrepareCoverageResult } from "../shadow/prepare-types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { RunSeams } from "./seams.ts";
import { stageRunAsync } from "./staging.ts";

const COVERAGE_PLACE = "/test/.jest-roblox/coverage/game.rbxl";
const BUILD_MANIFEST_PATH = path.resolve("/test", ".jest-roblox/coverage/build-manifest.json");

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...createResolvedConfig(),
		placeFile: "/test/game.rbxl",
		rojoProject: "default.project.json",
		rootDir: "/test",
		...overrides,
	};
}

function makeProject(): ResolvedProjectConfig {
	return fromAny({
		config: {},
		displayName: "main",
		include: ["src/**/*.spec.ts"],
		projects: ["game.ReplicatedStorage.rbxts_include.node_modules"],
		rojoMounts: [],
		testMatch: ["**/*.spec.ts"],
	});
}

function makeCoverageResult(rebuilt = true): PrepareCoverageResult {
	return fromAny({
		buildId: "build-1",
		coveragePlace: { hash: "place-hash", path: COVERAGE_PLACE },
		files: {},
		instrumentMs: 0,
		manifest: { generatedAt: "2026-06-07T00:00:00.000Z" },
		placeFile: COVERAGE_PLACE,
		rebuilt,
		stagingMs: 0,
	});
}

function makeSeams(): RunSeams {
	return createRunSeams({
		prepareCoverage: vi.fn<RunSeams["prepareCoverage"]>(async () => makeCoverageResult()),
	});
}

async function stageAsync({
	fileSystem,
	projects = [makeProject()],
	rootConfig,
	seams,
}: {
	fileSystem: FileSystem;
	projects?: Array<ResolvedProjectConfig>;
	rootConfig: ResolvedConfig;
	seams: RunSeams;
}) {
	return stageRunAsync({
		fileSystem,
		projects,
		rootConfig,
		seams,
		timing: clockTimingCollector(),
	});
}

describe(stageRunAsync, () => {
	// `buildSourceMapper` resolves a DataModel path to a file through the
	// `rojoProject` this config carries, then reads `<outDir>/x.luau.map`.
	// Only the user's project points at the real `outDir`; the synthesized
	// coverage project points into the shadow tree, whose `.luau.map`
	// mirroring is incidental rather than guaranteed. Swapping the field
	// degrades every frame to a bare Luau path with no error, so the whole
	// object is pinned rather than one key.
	it("should change only placeFile when coverage rebuilds the place", async () => {
		expect.assertions(3);

		const { fileSystem } = createMemoryFileSystem();
		const rootConfig = makeConfig({ collectCoverage: true });
		// Snapshot before the call, so a field mutated in place cannot move
		// the oracle along with the value under test.
		const before = structuredClone(rootConfig);

		const staged = await stageAsync({ fileSystem, rootConfig, seams: makeSeams() });

		expect(before.placeFile).not.toBe(COVERAGE_PLACE);
		expect(rootConfig).toStrictEqual(before);
		expect(staged.effectiveConfig).toStrictEqual({
			...before,
			placeFile: COVERAGE_PLACE,
		});
	});

	it("should carry the prepared coverage manifest", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const staged = await stageAsync({
			fileSystem,
			rootConfig: makeConfig({ collectCoverage: true }),
			seams: makeSeams(),
		});

		expect(staged.coverageManifest).toStrictEqual(makeCoverageResult().manifest);
	});

	it("should time coverage preparation as its own phase", async () => {
		expect.assertions(1);

		const timing = fakeTimingCollector();
		await stageRunAsync({
			fileSystem: createMemoryFileSystem().fileSystem,
			projects: [makeProject()],
			rootConfig: makeConfig({ collectCoverage: true }),
			seams: makeSeams(),
			timing,
		});

		expect(phaseNamesOf(timing.profileAsync)).toContain("prepareCoverage");
	});

	it("should pass the root config through untouched without coverage", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();
		const seams = makeSeams();
		const rootConfig = makeConfig();
		const before = structuredClone(rootConfig);

		const staged = await stageAsync({ fileSystem, rootConfig, seams });

		expect(staged.effectiveConfig).toStrictEqual(before);
		expect(seams.prepareCoverage).not.toHaveBeenCalled();
	});

	it("should hand coverage a stub bake", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const seams = makeSeams();

		await stageAsync({ fileSystem, rootConfig: makeConfig({ collectCoverage: true }), seams });

		expect(vi.mocked(seams.prepareCoverage).mock.calls[0]![1].bake).toBeDefined();
	});

	it("should build the coverage place through the run's own rojo launcher", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const seams = makeSeams();

		await stageAsync({ fileSystem, rootConfig: makeConfig({ collectCoverage: true }), seams });

		expect(vi.mocked(seams.prepareCoverage).mock.calls[0]![1].childProcess).toBe(
			seams.childProcess,
		);
	});

	it("should publish a coveragePlace-only build manifest when the place was rebuilt", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		await stageAsync({
			fileSystem,
			rootConfig: makeConfig({ collectCoverage: true }),
			seams: makeSeams(),
		});

		const manifest = JSON.parse(String(volume.readFileSync(BUILD_MANIFEST_PATH, "utf8")));

		expect(manifest).toMatchObject({
			buildId: "build-1",
			coveragePlace: { hash: "place-hash", path: COVERAGE_PLACE },
		});
		expect(manifest).not.toHaveProperty("cleanPlace");
	});

	it("should record one manifest project per DataModel mount", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const projects: Array<ResolvedProjectConfig> = fromAny([
			{
				config: { jestPath: "RS/jest", setupFiles: ["RS/setup"], setupFilesAfterEnv: [] },
				displayName: "client",
				include: ["src/**/*.spec.ts"],
				projects: ["ReplicatedStorage/client"],
				rojoMounts: [],
				testMatch: ["**/*.spec"],
			},
			{
				config: {},
				displayName: "shared",
				include: ["src/**/*.spec.ts"],
				projects: ["ReplicatedStorage/a", "ServerScriptService/b"],
				rojoMounts: [],
				testMatch: ["**/*.spec"],
			},
		]);

		const staged = await stageAsync({
			fileSystem,
			projects,
			rootConfig: makeConfig({ collectCoverage: true }),
			seams: makeSeams(),
		});

		expect(staged.coverageArtifacts!.projects).toStrictEqual([
			{
				displayName: "client",
				jestDataModelPath: "RS/jest",
				projectDataModelPath: "ReplicatedStorage/client",
				setupFiles: ["RS/setup"],
				setupFilesAfterEnv: [],
				testMatch: ["**/*.spec"],
			},
			{
				displayName: "shared",
				projectDataModelPath: "ReplicatedStorage/a",
				setupFiles: [],
				setupFilesAfterEnv: [],
				testMatch: ["**/*.spec"],
			},
			{
				displayName: "shared",
				projectDataModelPath: "ServerScriptService/b",
				setupFiles: [],
				setupFilesAfterEnv: [],
				testMatch: ["**/*.spec"],
			},
		]);
	});

	it("should leave the build manifest alone when the place was reused", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		const seams = createRunSeams({
			prepareCoverage: vi.fn<RunSeams["prepareCoverage"]>(async () => {
				return makeCoverageResult(false);
			}),
		});

		await stageAsync({ fileSystem, rootConfig: makeConfig({ collectCoverage: true }), seams });

		expect(volume.existsSync(BUILD_MANIFEST_PATH)).toBeFalse();
	});
});
