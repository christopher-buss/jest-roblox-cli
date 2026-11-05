import { loadConfig } from "@isentinel/jest-roblox/artifacts";

import path from "node:path";
import { describe, expect, it } from "vitest";

const LUAU_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/luau-project");
const RBXTS_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/rbxts-project");
const PARALLEL_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/parallel-config-project");
const MULTI_ROOT_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/multi-root-project");

describe("config resolution", () => {
	describe("luau project", () => {
		it("should load config from jest.config.luau", async () => {
			expect.assertions(2);

			const config = await loadConfig({ cwd: LUAU_FIXTURE });

			expect(config.rootDir).toBe(LUAU_FIXTURE);
			expect(config.placeFile).toBe("game.rbxl");
		});
	});

	describe("roblox-ts project", () => {
		it("should load config from jest.config.ts", async () => {
			expect.assertions(2);

			const config = await loadConfig({ cwd: RBXTS_FIXTURE });

			expect(config.rootDir).toBe(RBXTS_FIXTURE);
			expect(config.projects).toStrictEqual([
				{
					test: {
						displayName: "rbxts-e2e",
						include: ["src/**/*.spec.ts"],
						outDir: "out",
					},
				},
			]);
		});
	});

	describe("multi-root project", () => {
		it("should load the service-spanning project entry", async () => {
			expect.assertions(1);

			const config = await loadConfig({ cwd: MULTI_ROOT_FIXTURE });

			expect(config.projects).toStrictEqual([
				{
					test: {
						displayName: "multi-root-e2e",
						include: ["pkg/src/**/*.spec.luau"],
					},
				},
			]);
		});
	});

	describe("parallel config", () => {
		it("should read parallel from jest.config.ts", async () => {
			expect.assertions(1);

			const config = await loadConfig({ cwd: PARALLEL_FIXTURE });

			expect(config.parallel).toBe(4);
		});
	});
});
