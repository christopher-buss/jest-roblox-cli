import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauTree,
	spawnHarness,
	stubbedModules,
} from "#test/luau/lute-harness.ts";

// Drives the multi-mode runner under lute with the real Game Output capture,
// watchdog and result seam, and every other sibling stubbed by the harness.
// Requires `lute` on PATH (mise, in dev and CI).
const HARNESS = readHarness("runner");
const STUBBED = stubbedModules(HARNESS);

describe("multi-mode runner under lute", () => {
	it("should pass the runner harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, {
			__CAPTURE_MODULE__: readLuauTree("game-output-capture.luau", STUBBED),
			__INFINITE_YIELD_MODULE__: readLuauTree("infinite-yield.luau", STUBBED),
			__INTERCEPT_WRITEABLE_MODULE__: readLuauTree("intercept-writeable.luau", STUBBED),
			__LAST_SEEN_MODULE__: readLuauTree("last-seen.luau", STUBBED),
			__MODULE__: readLuauTree("runner.luau", STUBBED),
			__PROCESS_CAPTURE_MODULE__: readLuauTree("process-capture.luau", STUBBED),
			__RUN_ONCE_MODULE__: readLuauTree("run-once.luau", STUBBED),
			__RUNNER_RESULT_MODULE__: readLuauTree("runner-result.luau", STUBBED),
		});

		expect(spawnHarness("runner-", script)).toContain("ALL OK");
	});
});
