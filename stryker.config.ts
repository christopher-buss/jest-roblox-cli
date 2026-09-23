import { availableParallelism } from "node:os";

import { type PartialStrykerOptions, scopedBreak, sharedConfig } from "./stryker.shared.config.ts";

const CPU_SHARE = 0.75;
const MAX_CONCURRENCY = 12;

export default {
	...sharedConfig,
	// Higher concurrency causes false timeouts that inflate the mutation score.
	concurrency: Math.max(
		1,
		Math.min(MAX_CONCURRENCY, Math.floor(availableParallelism() * CPU_SHARE)),
	),
	// Preserve type checking and deliberate errors in typecheck fixtures.
	disableTypeChecks: false,
	ignorePatterns: ["dist", "coverage", "out-tsc", ".eslintcache", "test/e2e/cli/.tmp/**"],
	mutate: [
		...(sharedConfig.mutate ?? []).filter(
			(pattern): pattern is string => pattern !== undefined,
		),
		"!src/**/__fixtures__/**",
		"!src/sea-entry.ts",
	],
	// The gate compares the unrounded score. `scopedBreak` holds diff-mode runs
	// to 100 regardless, so the floor covers existing debt and never the lines a
	// change touches.
	thresholds: {
		...sharedConfig.thresholds,
		break: scopedBreak(99.82),
	},
	timeoutMS: 10_000,
	tsconfigFile: "tsconfig.json",
	vitest: {
		configFile: "vitest.stryker.config.ts",
	},
} satisfies PartialStrykerOptions;
