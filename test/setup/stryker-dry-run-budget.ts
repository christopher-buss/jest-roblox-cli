import { inject, vi } from "vitest";

/** Vitest's default, which is the budget the `unit` project runs on. */
const DRY_RUN_TEST_TIMEOUT_MS = 5000;

// The 100ms cap in `vitest.stryker.config.ts` bounds a mutant, and the dry run
// carries none — it measures per-test coverage on the sources as written, so
// nothing in it can busy-loop. What the cap does reach is the one phase that
// cannot absorb a stray failure: a timed-out mutant run misreports a single
// mutant, while a timed-out dry run aborts the target with a `ConfigError` and
// discards the whole measurement. So the dry run takes the suite's ordinary
// budget and the mutant runs keep the cap. Setup files run before collection,
// which is where vitest reads `testTimeout` onto each task, so this lands in
// time.
if (inject("mode") === "dry-run") {
	vi.setConfig({ testTimeout: DRY_RUN_TEST_TIMEOUT_MS });
}
