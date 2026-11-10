import { inject, vi } from "vitest";

const DRY_RUN_TEST_TIMEOUT_MS = 5000;

// The dry run discards everything on one timeout, so it skips the mutant cap.
// Setup files run before collection, where vitest reads `testTimeout`.
if (inject("mode") === "dry-run") {
	vi.setConfig({ testTimeout: DRY_RUN_TEST_TIMEOUT_MS });
}
