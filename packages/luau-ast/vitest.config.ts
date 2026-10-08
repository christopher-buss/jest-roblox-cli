import { defineConfig, mergeConfig } from "vitest/config";

import { sharedConfig, unitProject } from "../../vitest.shared.ts";

export default mergeConfig(
	sharedConfig,
	defineConfig({
		test: {
			coverage: { exclude: ["src/luau-compiler-wasm.ts", "src/luau-parser-wasm.ts"] },
			projects: [
				unitProject,
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
