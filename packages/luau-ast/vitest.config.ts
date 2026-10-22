import { defineConfig, mergeConfig } from "vitest/config";

import { sharedConfig, unitProject } from "../../vitest.shared.ts";

export default mergeConfig(
	sharedConfig,
	defineConfig({
		test: {
			coverage: {
				exclude: [
					"src/luau-compiler-wasm.ts",
					"src/luau-parser-wasm.ts",
					"src/**/*-types.ts",
					"src/**/*.d.ts",
				],
				include: ["src/**/*.ts"],
				reporter: ["text", "json", "json-summary"],
			},
			projects: [
				unitProject,
				{
					extends: true,
					test: {
						name: "type",
						include: [],
						typecheck: {
							build: true,
							checker: "tsc",
							enabled: true,
							include: ["src/**/*.spec-d.ts"],
							only: true,
							tsconfig: "./tsconfig.spec.json",
						},
					},
				},
				{
					extends: true,
					test: { name: "integration", include: ["test/integration/**/*.spec.ts"] },
				},
				{
					extends: true,
					test: { name: "end-to-end", include: ["test/e2e/**/*.spec.ts"] },
				},
			],
		},
	}),
);
