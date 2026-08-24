import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		clearMocks: true,
		coverage: {
			exclude: ["src/luau-parser-wasm.ts"],
			thresholds: {
				branches: 100,
				functions: 100,
				lines: 100,
				statements: 100,
			},
		},
		include: ["src/**/*.spec.ts"],
		restoreMocks: true,
		unstubEnvs: true,
	},
});
