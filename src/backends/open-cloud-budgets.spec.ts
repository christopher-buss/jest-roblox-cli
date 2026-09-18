import { describe, expect, it } from "vitest";

import { openCloudExecutionBudgets } from "./open-cloud-budgets.ts";

describe(openCloudExecutionBudgets, () => {
	it.for([
		{
			expected: {
				inputValidityMs: 540_000,
				maximumSubmitMs: 495_000,
				observationMs: 555_000,
				startupWindowMs: 3_510_000,
				submitBudget: 90_000,
				submitCapacityBudget: 405_000,
			},
			timeout: 15_000,
		},
		{
			expected: {
				inputValidityMs: 540_000,
				maximumSubmitMs: 495_000,
				observationMs: 570_000,
				startupWindowMs: 3_645_000,
				submitBudget: 90_000,
				submitCapacityBudget: 405_000,
			},
			timeout: 30_000,
		},
		{
			expected: {
				inputValidityMs: 540_000,
				maximumSubmitMs: 495_000,
				observationMs: 840_000,
				startupWindowMs: 6_075_000,
				submitBudget: 90_000,
				submitCapacityBudget: 405_000,
			},
			timeout: 300_000,
		},
	])("should bound the full recovery path for a $timeout ms task", ({ expected, timeout }) => {
		expect.assertions(1);

		expect(openCloudExecutionBudgets(timeout)).toStrictEqual(expected);
	});
});
