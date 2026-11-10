/** Default wall-clock budget of a run, in milliseconds. */
export const RUN_TIMEOUT_MS = 300_000;

/**
 * Default TTL of work-stealing queue items and streamed results, in seconds.
 */
export const QUEUE_TTL_SECONDS = 600;

/** Bytes a workspace task returns before it defers the rest. */
export const RESULT_BUDGET_BYTES = 3_400_000;
