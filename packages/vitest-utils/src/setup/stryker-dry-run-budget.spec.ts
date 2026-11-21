import { describe, it, vi } from "vitest";

import { restoreDryRunBudget } from "./stryker-dry-run-budget.ts";

describe(restoreDryRunBudget, () => {
	it("should give the dry run the default budgets", ({ expect }) => {
		expect.assertions(1);

		const setConfig = vi.spyOn(vi, "setConfig").mockReturnValue(undefined);

		restoreDryRunBudget("dry-run");

		expect(setConfig).toHaveBeenCalledExactlyOnceWith({
			hookTimeout: 10_000,
			testTimeout: 5000,
		});
	});

	it.for(["mutant", undefined] as const)(
		"should keep the configured budgets when the mode is %s",
		(mode, { expect }) => {
			expect.assertions(1);

			const setConfig = vi.spyOn(vi, "setConfig").mockReturnValue(undefined);

			restoreDryRunBudget(mode);

			expect(setConfig).not.toHaveBeenCalled();
		},
	);
});
