import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		{
			name: "luau-raw",
			load(id) {
				if (!id.endsWith(".luau")) {
					return;
				}

				const content = readFileSync(id, "utf-8");
				return `export default ${JSON.stringify(content)};`;
			},
		},
	],
	test: {
		clearMocks: true,
		coverage: {
			exclude: ["src/**/*.luau", "src/**/*.spec-d.ts", "test/mocks/**", "package.json"],
			thresholds: {
				branches: 100,
				functions: 100,
				lines: 100,
				statements: 100,
			},
		},
		env: {
			GITHUB_ACTIONS: "",
		},
		exclude: [
			"src/**/__fixtures__/**",
			"test/fixtures/**",
			"**/src/types/**",
			"./src/cli.ts",
			"**/*.luau",
		],
		include: ["src/**/*.spec.ts", "test/**/*.spec.ts"],
		restoreMocks: true,
		setupFiles: ["./test/setup/jest-extended.ts"],
		typecheck: {
			checker: "tsgo",
			enabled: true,
			include: ["src/**/*.spec-d.ts"],
			tsconfig: "./tsconfig.spec.json",
		},
		unstubEnvs: true,
	},
});
