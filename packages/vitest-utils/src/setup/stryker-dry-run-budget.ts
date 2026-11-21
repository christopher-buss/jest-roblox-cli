import { inject, type ProvidedContext, vi } from "vitest";

const DRY_RUN_HOOK_TIMEOUT_MS = 10_000;
const DRY_RUN_TEST_TIMEOUT_MS = 5000;

/**
 * Gives the Stryker dry run Vitest's default budgets back.
 *
 * @param mode - The run `@stryker-mutator/vitest-runner` drives, if any.
 */
export function restoreDryRunBudget(mode: ProvidedContext["mode"]): void {
	if (mode === "dry-run") {
		vi.setConfig({
			hookTimeout: DRY_RUN_HOOK_TIMEOUT_MS,
			testTimeout: DRY_RUN_TEST_TIMEOUT_MS,
		});
	}
}

// Setup files run before collection, where vitest reads both timeouts.
restoreDryRunBudget(inject("mode"));
