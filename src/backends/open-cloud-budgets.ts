import { maximumSubmitDuration } from "@isentinel/roblox-runner";

import { DEFAULT_BOOT_WATCH_MS } from "./execution-recovery.ts";

const SUBMIT_BUDGET_MS = 90_000;
const SUBMIT_CAPACITY_BUDGET_MS = 405_000;
const PHYSICAL_SUBMIT_LIMIT = 6;
const NATIVE_RESULT_READ_LIMIT = 3;

/** Bounds shared by admission, result observation, and the execution claim. */
export function openCloudExecutionBudgets(timeout: number): {
	inputValidityMs: number;
	maximumSubmitMs: number;
	observationMs: number;
	startupWindowMs: number;
	submitBudget: number;
	submitCapacityBudget: number;
} {
	const maximumSubmitMs = maximumSubmitDuration({
		submitBudget: SUBMIT_BUDGET_MS,
		submitCapacityBudget: SUBMIT_CAPACITY_BUDGET_MS,
	});
	const resultReadMs = timeout + DEFAULT_BOOT_WATCH_MS;
	const observationMs = maximumSubmitMs + resultReadMs;
	return {
		inputValidityMs: maximumSubmitMs + DEFAULT_BOOT_WATCH_MS,
		maximumSubmitMs,
		observationMs,
		// Sized for the recovery chain this backend still runs. The recovery
		// rewrite owns this number; it is not re-derived here.
		startupWindowMs:
			PHYSICAL_SUBMIT_LIMIT * observationMs + NATIVE_RESULT_READ_LIMIT * resultReadMs,
		submitBudget: SUBMIT_BUDGET_MS,
		submitCapacityBudget: SUBMIT_CAPACITY_BUDGET_MS,
	};
}
