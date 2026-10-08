import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config";

const FULL_COVERAGE = { branches: 100, functions: 100, lines: 100, statements: 100 };

export const unitProject = {
	extends: true,
	test: { name: "unit", include: ["src/**/*.spec.ts"] },
} satisfies TestProjectInlineConfiguration;

export const sharedConfig = defineConfig({
	environments: {
		ssr: {
			resolve: {
				// Workspace deps resolve to `exports.source` first.
				conditions: ["source", "module", "node", "development|production"],
			},
		},
	},
	test: {
		clearMocks: true,
		coverage: {
			exclude: ["src/**/*.spec-d.ts", "test/helpers/**", "package.json"],
			thresholds: FULL_COVERAGE,
		},
		restoreMocks: true,
		setupFiles: ["./test/setup/jest-extended.ts"],
		unstubEnvs: true,
		watch: false,
	},
});
