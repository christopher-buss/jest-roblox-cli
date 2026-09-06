import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import { DEFAULT_CONFIG, type ResolvedConfig } from "../config/schema.ts";
import type { PrepareCoverageResult } from "../coverage-pipeline/prepare.ts";
import { NOOP_TIMING_COLLECTOR } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { RunSeams } from "./seams.ts";
import { nodeRunSeams } from "./seams.ts";
import { stageRunAsync } from "./staging.ts";

const COVERAGE_PLACE = "/test/.jest-roblox/coverage/game.rbxl";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...DEFAULT_CONFIG,
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

function makeCoverageResult(): PrepareCoverageResult {
	return fromAny({
		instrumentMs: 0,
		manifest: { generatedAt: "2026-06-07T00:00:00.000Z" },
		placeFile: COVERAGE_PLACE,
		stagingMs: 0,
	});
}

function makeSeams(): RunSeams {
	return {
		...nodeRunSeams(),
		prepareCoverage: vi.fn<RunSeams["prepareCoverage"]>(async () => makeCoverageResult()),
	};
}

async function stageAsync(rootConfig: ResolvedConfig, seams: RunSeams, fileSystem: FileSystem) {
	return stageRunAsync({
		fileSystem,
		projects: [makeProject()],
		rootConfig,
		seams,
		timing: NOOP_TIMING_COLLECTOR,
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

		const staged = await stageAsync(rootConfig, makeSeams(), fileSystem);

		expect(before.placeFile).not.toBe(COVERAGE_PLACE);
		expect(rootConfig).toStrictEqual(before);
		expect(staged.effectiveConfig).toStrictEqual({
			...before,
			placeFile: COVERAGE_PLACE,
		});
	});

	it("should pass the root config through untouched without coverage", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();
		const seams = makeSeams();
		const rootConfig = makeConfig();
		const before = structuredClone(rootConfig);

		const staged = await stageAsync(rootConfig, seams, fileSystem);

		expect(staged.effectiveConfig).toStrictEqual(before);
		expect(seams.prepareCoverage).not.toHaveBeenCalled();
	});

	it("should hand coverage a stub bake for every backend but studio-cli", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();
		const seams = makeSeams();

		await stageAsync(makeConfig({ collectCoverage: true }), seams, fileSystem);
		await stageAsync(
			makeConfig({ backend: "studio-cli", collectCoverage: true }),
			seams,
			fileSystem,
		);

		const [baked, unbaked] = vi.mocked(seams.prepareCoverage).mock.calls;

		expect(baked![1]!.bake).toBeDefined();
		expect(unbaked![1]!.bake).toBeUndefined();
	});

	it("should build the coverage place through the run's own rojo launcher", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const seams = makeSeams();

		await stageAsync(makeConfig({ collectCoverage: true }), seams, fileSystem);

		expect(vi.mocked(seams.prepareCoverage).mock.calls[0]![1]!.childProcess).toBe(
			seams.childProcess,
		);
	});
});
