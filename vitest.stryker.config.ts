import { defineConfig, mergeConfig } from "vitest/config";

import { baseConfig, sharedViteOptions, unitProject } from "./vitest.config.ts";

// Stryker runs one suite: the coverage-measured `unit` project, hoisted to the
// root so there is no `projects` array to filter (the vitest runner exposes no
// project filter). The others are unaffordable per mutant: `integration`
// boots the real c12/jiti loader, `e2e` spawns the built CLI, and `live` talks
// to Open Cloud.
export default mergeConfig(
	baseConfig,
	defineConfig({
		...sharedViteOptions,
		test: {
			...unitProject.test,
			hookTimeout: 100,
			// Reaches the mutant runs only; the dry-run setup hands the dry run
			// the suite's ordinary budget back.
			setupFiles: [
				...unitProject.test.setupFiles,
				"@isentinel/dev-vitest-utils/setup/stryker-dry-run-budget",
			],
			// A mutant that slips a busy async loop past Stryker's run budget is
			// the pathology; a healthy unit test finishes far inside 100ms.
			testTimeout: 100,
		},
	}),
);
