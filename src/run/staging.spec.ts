import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import type { ResolvedProjectConfig } from "../config/projects.ts";
import { DEFAULT_CONFIG, type ResolvedConfig } from "../config/schema.ts";
import { cleanLeftoverStubs, generateProjectStubs } from "../config/stubs.ts";
import { prepareCoverageAsync, toCoverageArtifacts } from "../coverage-pipeline/prepare.ts";
import { NOOP_TIMING_COLLECTOR } from "../timing/orchestration-collector.ts";
import { stageRunAsync } from "./staging.ts";

// No `node:fs` mock: every path `stageRun` takes here goes through one of the
// two mocked modules, so nothing reaches the filesystem.
vi.mock(import("../config/stubs"));
vi.mock(import("../coverage-pipeline/prepare"));

const COVERAGE_PLACE = "/test/.jest-roblox/coverage/game.rbxl";

const mocks = {
	cleanLeftoverStubs: vi.mocked(cleanLeftoverStubs),
	generateProjectStubs: vi.mocked(generateProjectStubs),
	prepareCoverageAsync: vi.mocked(prepareCoverageAsync),
	toCoverageArtifacts: vi.mocked(toCoverageArtifacts),
};

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

describe("staging", () => {
	function setupMocks(): void {
		mocks.cleanLeftoverStubs.mockReturnValue([]);
		mocks.generateProjectStubs.mockReturnValue();
		mocks.toCoverageArtifacts.mockReturnValue(fromAny({}));
		// The three fields `stageRun` reads. The rest of `PrepareCoverageResult`
		// reaches `toCoverageArtifacts`, which is mocked, so filling it in would
		// only give a future field one more place to be added.
		mocks.prepareCoverageAsync.mockResolvedValue(
			fromAny({ instrumentMs: 0, placeFile: COVERAGE_PLACE, stagingMs: 0 }),
		);
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

			setupMocks();
			const rootConfig = makeConfig({ collectCoverage: true });
			// Snapshot before the call, so a field mutated in place cannot move
			// the oracle along with the value under test.
			const before = structuredClone(rootConfig);

			const staged = await stageRunAsync([makeProject()], rootConfig, NOOP_TIMING_COLLECTOR);

			expect(before.placeFile).not.toBe(COVERAGE_PLACE);
			expect(rootConfig).toStrictEqual(before);
			expect(staged.effectiveConfig).toStrictEqual({
				...before,
				placeFile: COVERAGE_PLACE,
			});
		});

		it("should pass the root config through untouched without coverage", async () => {
			expect.assertions(2);

			setupMocks();
			const rootConfig = makeConfig();
			const before = structuredClone(rootConfig);

			const staged = await stageRunAsync([makeProject()], rootConfig, NOOP_TIMING_COLLECTOR);

			expect(staged.effectiveConfig).toStrictEqual(before);
			expect(mocks.prepareCoverageAsync).not.toHaveBeenCalled();
		});
	});
});
