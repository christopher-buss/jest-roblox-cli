// Vendored from the monorepo, where these options are shared across every
// mutation-tested project. Edits here are overwritten on the next sync.

import type { PartialStrykerOptions } from "@stryker-mutator/api/core";
import { declareValuePlugin, PluginKind, type ValuePlugin } from "@stryker-mutator/api/plugin";
import type { babel } from "@stryker-mutator/instrumenter";

import process from "node:process";

const ASSERT_MESSAGE_IGNORER = "assert-message";

/**
 * Stryker's plugin loader reads this export by name.
 */
export const strykerPlugins: Array<ValuePlugin<PluginKind.Ignore>> = [
	declareValuePlugin(PluginKind.Ignore, ASSERT_MESSAGE_IGNORER, {
		shouldIgnore(path: babel.NodePath): string | undefined {
			if (path.listKey !== "arguments" || path.key !== 1) {
				return undefined;
			}

			const call = path.parentPath as babel.NodePath | null;
			if (
				call?.isCallExpression() !== true ||
				!call.get("callee").isIdentifier({ name: "assert" })
			) {
				return undefined;
			}

			return "An assert message is developer-facing text, not behavior.";
		},
	}),
];

/**
 * The `break` threshold a run should enforce, given a package's own floor.
 *
 * A scoped run gets none: the diff invoker holds its changed lines to 100.
 *
 * @param floor - The package's measured floor, for an unscoped run.
 * @returns The threshold this run should break on, or `null` for none.
 */
export function scopedBreak(floor: number): null | number {
	return process.env["MUTATE_SCOPED"] === undefined ? floor : null;
}

export const sharedConfig: PartialStrykerOptions = {
	checkers: ["typescript"],
	// `stryker-adaptive` overrides this per run from the machine budget. This
	// remains the standalone default for direct Stryker use.
	concurrency: "75%",
	coverageAnalysis: "perTest",
	htmlReporter: { fileName: "reports/mutation/index.html" },
	// Stryker does not read `.gitignore`; a cache another target rewrites
	// mid-copy fails the sandbox with ENOENT.
	ignorePatterns: [".eslintcache", "coverage", "projectStructure.cache.json"],
	ignorers: [ASSERT_MESSAGE_IGNORER],
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
	plugins: [
		"@stryker-mutator/vitest-runner",
		"@stryker-mutator/typescript-checker",
		import.meta.url,
	],
	reporters: ["html", "clear-text", "progress"],
	testRunner: "vitest",
	thresholds: { break: scopedBreak(100), high: 100, low: 100 },
	// Padding added on top of 1.5x the dry-run net time before a mutant counts
	// as timed out. Mutation suites here are unit-only with tight per-test
	// vitest caps, so the 5s default buys nothing but a longer wait on every
	// hung mutant.
	timeoutMS: 2000,
} satisfies PartialStrykerOptions;

export { type PartialStrykerOptions } from "@stryker-mutator/api/core";
