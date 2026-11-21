import { defineConfig } from "vitest/config";

import { unitProject } from "./vitest.shared.ts";

// Merged onto `sharedConfig`, not a project config: the Stryker vitest runner
// has no project filter, so `projects` must stay absent.
export const strykerConfig = defineConfig({
	test: {
		deps: unitProject.test.deps,
		hookTimeout: 1000,
		include: unitProject.test.include,
		setupFiles: [
			...unitProject.test.setupFiles,
			"@isentinel/dev-vitest-utils/setup/stryker-dry-run-budget",
		],
		// Catches a mutant that spins an async loop past the run budget.
		testTimeout: 1000,
		typecheck: {
			enabled: false,
		},
	},
});
