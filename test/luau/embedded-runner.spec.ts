import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauTree,
	spawnHarness,
	stubbedModules,
} from "#test/luau/lute-harness.ts";

// Drives the embedded workspace runner under lute with the real Game Output
// capture module and every other sibling stubbed by the harness. Requires
// `lute` on PATH (mise, in dev and CI).
const HARNESS = readHarness("embedded-runner");
const STUBBED = stubbedModules(HARNESS);

describe("embedded workspace runner under lute", () => {
	it("should pass the embedded-runner harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, {
			__BAIL_MODULE__: readLuauTree("staging/bail.luau", STUBBED),
			__CAPTURE_MODULE__: readLuauTree("game-output-capture.luau", STUBBED),
			__INFINITE_YIELD_MODULE__: readLuauTree("infinite-yield.luau", STUBBED),
			__INTERCEPT_WRITEABLE_MODULE__: readLuauTree("intercept-writeable.luau", STUBBED),
			__LAST_SEEN_MODULE__: readLuauTree("last-seen.luau", STUBBED),
			__MODULE__: readLuauTree("staging/embedded-runner.luau", STUBBED),
			__PROCESS_CAPTURE_MODULE__: readLuauTree("process-capture.luau", STUBBED),
			__RESULT_BUDGET_MODULE__: readLuauTree("staging/result-budget.luau", STUBBED),
			__RUN_ONCE_MODULE__: readLuauTree("run-once.luau", STUBBED),
			__RUNNER_RESULT_MODULE__: readLuauTree("runner-result.luau", STUBBED),
		});

		expect(spawnHarness("embedded-runner-", script)).toContain("ALL OK");
	});
});
