import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { configDefaults, defineConfig, type TestProjectInlineConfiguration } from "vitest/config";

export const NO_PROCESS_START_SETUP = resolve(
	import.meta.dirname,
	"test/setup/no-process-start.ts",
);

// sync.sh copies this file to the jest-roblox mirror without the setup.
const MACHINE_BUDGET_SETUP = resolve(import.meta.dirname, "vitest.machine-budget.ts");

const FULL_COVERAGE = { branches: 100, functions: 100, lines: 100, statements: 100 };

export const unitProject = {
	extends: true,
	test: {
		name: "unit",
		deps: {
			optimizer: {
				ssr: {
					enabled: true,
					include: ["jest-extended"],
				},
			},
		},
		include: ["src/**/*.spec.ts"],
		maxWorkers: 4,
		sequence: {
			groupOrder: 1,
		},
		setupFiles: [NO_PROCESS_START_SETUP],
	},
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
		forceRerunTriggers: [
			...configDefaults.forceRerunTriggers,
			"**/fixtures/**",
			"**/__fixtures__/**",
			"**/pnpm-lock.yaml",
			"**/test/setup/**",
			"**/tsconfig*.json",
			"**/vitest.shared.ts",
		],
		globalSetup: existsSync(MACHINE_BUDGET_SETUP) ? [MACHINE_BUDGET_SETUP] : [],
		isolate: false,
		restoreMocks: true,
		setupFiles: ["./test/setup/jest-extended.ts"],
		unstubEnvs: true,
		watch: false,
	},
});
