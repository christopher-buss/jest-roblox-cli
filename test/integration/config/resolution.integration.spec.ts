import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../../src/config/loader.ts";
import { resolveAllProjects } from "../../../src/config/projects.ts";
import { isLuauProject, resolveAllTsconfigMappings } from "../../../src/executor.ts";
import { rojoProjectSchema } from "../../../src/types/rojo.ts";
import { readJsonSync } from "../../e2e/cli/helpers.ts";

const LUAU_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/luau-project");
const RBXTS_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/rbxts-project");
const PARALLEL_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/parallel-config-project");

describe("config resolution", () => {
	describe("luau project", () => {
		it("should load config from jest.config.luau", async () => {
			expect.assertions(1);

			const config = await loadConfig(undefined, LUAU_FIXTURE);

			expect(config.rootDir).toBe(LUAU_FIXTURE);
		});

		it("should be detected as a luau project", async () => {
			expect.assertions(1);

			const tsconfigMappings = resolveAllTsconfigMappings(LUAU_FIXTURE);
			const testFiles = ["example.spec.luau"];

			expect(isLuauProject(testFiles, tsconfigMappings)).toBeTrue();
		});

		it("should have no tsconfig mappings", () => {
			expect.assertions(1);

			const mappings = resolveAllTsconfigMappings(LUAU_FIXTURE);

			expect(mappings).toHaveLength(0);
		});
	});

	describe("roblox-ts project", () => {
		it("should load config from jest.config.ts", async () => {
			expect.assertions(1);

			const config = await loadConfig(undefined, RBXTS_FIXTURE);

			expect(config.rootDir).toBe(RBXTS_FIXTURE);
		});

		it("should be detected as a roblox-ts project", () => {
			expect.assertions(1);

			const tsconfigMappings = resolveAllTsconfigMappings(RBXTS_FIXTURE);
			const testFiles = ["example.spec.ts"];

			expect(isLuauProject(testFiles, tsconfigMappings)).toBeFalse();
		});

		it("should resolve tsconfig mappings with outDir and rootDir", () => {
			expect.assertions(3);

			const mappings = resolveAllTsconfigMappings(RBXTS_FIXTURE);

			expect(mappings.length).toBeGreaterThan(0);
			expect(mappings[0]?.outDir).toContain("out");
			expect(mappings[0]?.rootDir).toContain("src");
		});

		it("should resolve projects from rojo tree", async () => {
			expect.assertions(1);

			const config = await loadConfig(undefined, RBXTS_FIXTURE);
			const rojoData = readJsonSync(path.join(RBXTS_FIXTURE, "default.project.json"));
			const rojo = rojoProjectSchema.assert(rojoData);

			const projects = await resolveAllProjects(
				config.projects ?? [],
				{ ...config, rootDir: RBXTS_FIXTURE },
				rojo.tree,
				RBXTS_FIXTURE,
			);

			expect(projects.length).toBeGreaterThan(0);
		});
	});

	describe("parallel config", () => {
		it("should read parallel from jest.config.ts", async () => {
			expect.assertions(1);

			const config = await loadConfig(undefined, PARALLEL_FIXTURE);

			expect(config.parallel).toBe(4);
		});
	});
});
