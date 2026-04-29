import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const luauPlugin = {
	name: "luau-raw",
	load(id: string) {
		if (id.endsWith(".lua")) {
			return "export default {};";
		}

		if (!id.endsWith(".luau")) {
			return;
		}

		const content = readFileSync(id, "utf-8");
		return `export default ${JSON.stringify(content)};`;
	},
};

const setupFiles = ["./test/setup/enable-colors.ts", "./test/setup/jest-extended.ts"];

export default defineConfig({
	plugins: [luauPlugin],
	test: {
		coverage: {
			exclude: [
				"dist/**",
				"src/**/*.luau",
				"src/**/*.spec-d.ts",
				"test/e2e/**",
				"test/mocks/**",
				"package.json",
			],
			thresholds: {
				branches: 100,
				functions: 100,
				lines: 100,
				statements: 100,
			},
		},
		projects: [
			{
				plugins: [luauPlugin],
				test: {
					name: "unit",
					clearMocks: true,
					env: {
						GITHUB_ACTIONS: "",
					},
					exclude: [
						"src/**/__fixtures__/**",
						"test/fixtures/**",
						"test/e2e/**",
						"**/src/types/**",
						"./src/cli.ts",
						"**/*.luau",
					],
					include: ["src/**/*.spec.ts", "test/**/*.spec.ts"],
					restoreMocks: true,
					setupFiles,
					typecheck: {
						checker: "tsgo",
						enabled: true,
						include: ["src/**/*.spec-d.ts"],
						tsconfig: "./tsconfig.spec.json",
					},
					unstubEnvs: true,
				},
			},
			{
				plugins: [luauPlugin],
				test: {
					name: "e2e",
					clearMocks: true,
					include: ["test/e2e/cli/**/*.e2e.spec.ts"],
					restoreMocks: true,
					setupFiles,
					testTimeout: 30_000,
					unstubEnvs: true,
				},
			},
			{
				plugins: [luauPlugin],
				test: {
					name: "live",
					clearMocks: true,
					fileParallelism: false,
					globalSetup: ["./test/e2e/fixtures/live-place/global-setup.ts"],
					include: [
						"test/e2e/contract/**/*.spec.ts",
						"test/e2e/project/**/*.e2e.spec.ts",
						"test/e2e/workspace/**/*.e2e.spec.ts",
					],
					maxWorkers: 1,
					pool: "forks",
					restoreMocks: true,
					setupFiles,
					testTimeout: 60_000,
					unstubEnvs: true,
				},
			},
		],
	},
});
