import { availableParallelism } from "node:os";

import { type PartialStrykerOptions, sharedConfig } from "./stryker.shared.config.ts";

const CPU_SHARE = 0.75;
const MAX_CONCURRENCY = 12;

export default {
	...sharedConfig,
	// Retain the shared 75%-of-CPU limit on smaller machines while keeping the
	// measured 12-worker ceiling. Higher concurrency caused healthy mutants to
	// be reported as timeouts, which inflated the score instead of testing them.
	concurrency: Math.max(
		1,
		Math.min(MAX_CONCURRENCY, Math.floor(availableParallelism() * CPU_SHARE)),
	),
	// Reads backwards: `false` is what KEEPS type checking. The default
	// prepends `// @ts-nocheck` to every sandbox file, which blinds the
	// typescript checker (nothing to reject) and defuses the deliberate
	// type errors in `test/fixtures/typecheck` that the typecheck runner's
	// integration tests assert on. Vitest strips types without checking them,
	// so nothing needs the prepend.
	disableTypeChecks: false,
	// Generated outputs are never inputs to the unit suite. In particular,
	// `dist` contains the 102 MB SEA executable; copying it into every sandbox
	// adds filesystem and antivirus work without changing mutant behaviour.
	ignorePatterns: ["dist", "coverage", "out-tsc"],
	// Test fixtures are inputs to formatter tests, not shipped implementation.
	// Mutating them only checks whether a test notices its own test data
	// changing.
	mutate: [
		...(sharedConfig.mutate ?? []).filter(
			(pattern): pattern is string => pattern !== undefined,
		),
		"!src/**/__fixtures__/**",
	],
	// A floor, not a target. It exists so a refactor that quietly weakens the
	// suite fails loudly; ratchet it up as survivors get killed, and delete it
	// once the repo's 100% policy is met.
	//
	// This one went DOWN once, from 93.5, and that is not a coverage
	// regression: 93.5 was measured while the vitest runner was reporting
	// mutants it had never tested (see the patch note for #776). The suite it
	// described did not exist, and the fixed runner measures the low nineties.
	// The floor sits a hundredth under the latest clean measurement: the gate
	// compares against the unrounded score, so a floor set to the number
	// Stryker prints fails on the very run that produced it.
	//
	// Measure from a deleted `reports/stryker-incremental.json`. An incremental
	// run reuses results whose tests have since changed, so it reports
	// survivors a full run kills and reads low by a few hundredths — enough to
	// fail this gate on a suite that passes it.
	thresholds: {
		...sharedConfig.thresholds,
		break: 92.99,
	},
	timeoutMS: 10_000,
	tsconfigFile: "tsconfig.json",
	vitest: {
		// Not `vitest.config.ts` — that one carries four projects, three of
		// which drive real processes or the network. See the header there.
		configFile: "vitest.stryker.config.ts",
	},
} satisfies PartialStrykerOptions;
