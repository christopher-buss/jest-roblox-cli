// Vendored from the monorepo, where these options are shared across every
// mutation-tested project. Edits here are overwritten on the next sync.

import type { PartialStrykerOptions } from "@stryker-mutator/api/core";

import process from "node:process";

/** Every mutant in the changed lines must die, whatever the package's floor. */
const SCOPED_BREAK = 100;

/**
 * The `break` threshold a run should enforce, given a package's own floor.
 *
 * A scoped run mutates only the lines a diff touched, so its denominator is
 * those lines alone: a package sitting below 100 could otherwise pass its floor
 * with a live survivor in the code it just changed. Holding scoped runs to 100
 * makes the floor a statement about existing debt rather than a permit to add
 * more.
 *
 * @param floor - The package's measured floor, for an unscoped run.
 * @returns The threshold this run should break on.
 */
export function scopedBreak(floor: number): number {
	return process.env["MUTATE_SCOPED"] === undefined ? floor : SCOPED_BREAK;
}

export const sharedConfig: PartialStrykerOptions = {
	checkers: ["typescript"],
	// The adaptive launcher owns the machine-wide 75% budget and overrides this
	// per run. This remains the safe standalone default for direct Stryker use.
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
