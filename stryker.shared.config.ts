// Vendored from the monorepo, where these options are shared across every
// mutation-tested project. Edits here are overwritten on the next sync.

import type { PartialStrykerOptions } from "@stryker-mutator/api/core";

export const sharedConfig: PartialStrykerOptions = {
	checkers: ["typescript"],
	// Headroom, so a run holding the lock leaves the machine usable. Stryker
	// resolves this against `os.availableParallelism()` in its own process and
	// coordinates with nothing, so it caps a single run and nothing more — the
	// `stryker-lock` shim is what stops two runs claiming 75% each.
	concurrency: "75%",
	coverageAnalysis: "perTest",
	htmlReporter: { fileName: "reports/mutation/index.html" },
	ignoreStatic: true,
	incremental: true,
	incrementalFile: "reports/stryker-incremental.json",
	mutate: [
		"src/**/*.ts",
		"!src/**/*.spec.ts",
		"!src/**/*.spec-d.ts",
		"!src/**/*.test.ts",
		"!src/**/*.test-d.ts",
		// Benchmarks are run by `vitest bench`, never by the test suite, so
		// every mutant in one survives by construction.
		"!src/**/*.bench.ts",
		"!src/**/*.d.ts",
	],
	plugins: ["@stryker-mutator/vitest-runner", "@stryker-mutator/typescript-checker"],
	reporters: ["html", "clear-text", "progress"],
	testRunner: "vitest",
	thresholds: { break: 100, high: 100, low: 100 },
	// Padding added on top of 1.5x the dry-run net time before a mutant counts
	// as timed out. Mutation suites here are unit-only with tight per-test
	// vitest caps, so the 5s default buys nothing but a longer wait on every
	// hung mutant.
	timeoutMS: 2000,
} satisfies PartialStrykerOptions;

export { type PartialStrykerOptions } from "@stryker-mutator/api/core";
