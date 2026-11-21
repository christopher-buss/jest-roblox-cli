import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config";

export const NO_PROCESS_START_SETUP = "@isentinel/dev-vitest-utils/setup/no-process-start";

// sync.sh copies this file to the jest-roblox mirror without the setup.
const MACHINE_BUDGET_SETUP = resolve(import.meta.dirname, "vitest.machine-budget.ts");

const GLOB_SPECIAL = /[!()*+?@[\]{|}]/g;
const DRIVE_LETTER = /^[a-z](?=:)/i;

function globAnchor(directory: string): string {
	return directory
		.replaceAll("\\", "/")
		.replace(GLOB_SPECIAL, "[$&]")
		.replace(DRIVE_LETTER, (letter) => `[${letter.toUpperCase()}${letter.toLowerCase()}]`);
}

const PROJECT_GLOB = globAnchor(process.cwd());
const WORKSPACE_GLOB = globAnchor(import.meta.dirname);

const FULL_COVERAGE = { branches: 100, functions: 100, lines: 100, statements: 100 };

export const unitProject = {
	extends: true,
	test: {
		name: "unit",
		deps: {
			optimizer: {
				ssr: {
					enabled: true,
					include: ["@isentinel/dev-vitest-utils > jest-extended"],
				},
			},
		},
		include: ["src/**/*.spec.ts"],
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
			`${PROJECT_GLOB}/**/package.json`,
			`${PROJECT_GLOB}/**/{vitest,vite}.config.*`,
			`${PROJECT_GLOB}/**/{fixtures,__fixtures__}/**`,
			`${PROJECT_GLOB}/**/test/setup/**`,
			`${PROJECT_GLOB}/**/tsconfig*.json`,
			`${WORKSPACE_GLOB}/tsconfig*.json`,
			`${WORKSPACE_GLOB}/libs/vitest-utils/src/setup/**`,
			`${WORKSPACE_GLOB}/vitest.shared.ts`,
		],
		globalSetup: existsSync(MACHINE_BUDGET_SETUP) ? [MACHINE_BUDGET_SETUP] : [],
		isolate: false,
		maxWorkers: 4,
		restoreMocks: true,
		setupFiles: ["@isentinel/dev-vitest-utils/setup/jest-extended"],
		slowTestThreshold: 100,
		unstubEnvs: true,
		watch: false,
	},
});
