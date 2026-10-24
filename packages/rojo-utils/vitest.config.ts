import { defineConfig, mergeConfig } from "vitest/config";

import { sharedConfig, unitProject } from "../../vitest.shared.ts";

export default mergeConfig(
	sharedConfig,
	defineConfig({
		test: {
			coverage: {
				exclude: [
					"src/**/*-types.ts",
					"src/**/*.d.ts",
					"src/**/*.spec.ts",
					"src/**/*.spec-d.ts",
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
			],
		},
	}),
);
