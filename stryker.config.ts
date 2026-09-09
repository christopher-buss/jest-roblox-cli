import { availableParallelism } from "node:os";

import { type PartialStrykerOptions, sharedConfig } from "./stryker.shared.config.ts";

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
	ignorePatterns: ["dist", "coverage", "out-tsc"],
	mutate: [
		...(sharedConfig.mutate ?? []).filter(
			(pattern): pattern is string => pattern !== undefined,
		),
		"!src/**/__fixtures__/**",
		"!src/sea-entry.ts",
	],
	// The gate compares the unrounded score.
	thresholds: {
		...sharedConfig.thresholds,
		break: 99.82,
	},
	timeoutMS: 10_000,
	tsconfigFile: "tsconfig.json",
	vitest: {
		configFile: "vitest.stryker.config.ts",
	},
} satisfies PartialStrykerOptions;
