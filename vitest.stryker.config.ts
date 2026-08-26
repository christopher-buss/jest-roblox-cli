import { defineConfig } from "vitest/config";

import { sharedViteOptions, unitProject } from "./vitest.config.ts";

// Stryker runs one suite: the coverage-measured `unit` project, hoisted to the
// root so there is no `projects` array to filter (the vitest runner exposes no
// project filter). The other three are unaffordable per mutant — `integration`
// boots the real c12/jiti loader, `e2e` spawns the built CLI, and `live` talks
// to Open Cloud. Type tests are dropped for the same reason: tsgo re-checks the
// whole project on every run, and `.spec-d.ts` files constrain types, not the
// runtime behaviour Stryker mutates.
export default defineConfig({
	...sharedViteOptions,
	...unitProject,
	test: {
		...unitProject.test,
		// Tests the `unit` project keeps but a mutation run cannot afford:
		// each spawns a real lute per test. With perTest coverage analysis
		// every mutant they cover re-pays that cost.
		exclude: [
			...unitProject.test.exclude,
			"test/luau/**",
			"test/coverage-pipeline/instrument-luau.spec.ts",
		],
		// Threads over the vitest default (forks): no process spawn per worker.
		// Safe since oxc-parser 0.146.0 — at 0.123.0 its native bindings hit a
		// segfault (0xC0000005) in worker threads, which forced `forks` here.
		pool: "threads",
		// A mutant that slips a busy async loop past Stryker's run budget is
		// the pathology; a healthy unit test finishes far inside 100ms. Tests
		// doing legitimately heavier work declare their own `{ timeout }` at
		// the test site.
		testTimeout: 100,
		typecheck: { enabled: false },
	},
});
