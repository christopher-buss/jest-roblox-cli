import { defineConfig, mergeConfig } from "vitest/config";

import { sharedConfig, unitProject } from "../../vitest.shared.ts";

export default mergeConfig(
	sharedConfig,
	defineConfig({
		test: {
			coverage: {
				exclude: ["src/**/*-types.ts", "src/**/*.d.ts"],
				include: ["src/**/*.ts"],
				reporter: ["text", "json", "json-summary"],
			},
			projects: [
				mergeConfig(unitProject, {
					test: {
						deps: {
							optimizer: {
								ssr: { include: ["arktype"] },
							},
						},
					},
				}),
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
