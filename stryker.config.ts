import { availableParallelism } from "node:os";
import { join } from "node:path";

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
	ignorePatterns: [
		"dist",
		"coverage",
		"out-tsc",
		".eslintcache",
		".standalone",
		"test/e2e/cli/.tmp/**",
		"test/e2e/fixtures/live-place/node_modules/**",
	],
	mutate: [
		...(sharedConfig.mutate ?? []).filter(
			(pattern): pattern is string => pattern !== undefined,
		),
		"!src/**/__fixtures__/**",
		"scripts/sea-executable.ts",
		"scripts/stamp-plugin-version.ts",
		"loaders/*.mjs",
		"!bin/jest-roblox.js",
		"!bin/sea-entry.ts",
		"!scripts/stamp-plugin-version.run.ts",
	],
	timeoutMS: 10_000,
	tsconfigFile: "tsconfig.json",
	vitest: {
		configFile: join(import.meta.dirname, "vitest.stryker.config.ts"),
	},
} satisfies PartialStrykerOptions;
