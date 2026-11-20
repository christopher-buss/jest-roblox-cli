/**
 * Fixed ceilings for live runs. They bound a wedged run rather than predict a
 * healthy one, so they stay above the CLI's own submit and recovery budgets
 * without restating how the CLI computes them.
 */
export const MAXIMUM_SUBMIT_MS = 10 * 60 * 1000;

/** How long one live CLI run may take to start its task, recovery included. */
export const LIVE_STARTUP_BUDGET_MS = 65 * 60 * 1000;
