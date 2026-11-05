import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	inlineRequires,
	readHarness,
	readLuauModule,
	spawnHarness,
} from "#test/luau/lute-harness.ts";
import { LUTE_HARNESS_TIMEOUT } from "#test/luau/lute-timeout.ts";

// Drives the multi-mode runner under lute with the real Game Output capture,
// watchdog and result seam, and every other sibling stubbed by the harness.
// Requires `lute` on PATH (mise, in dev and CI).
const HARNESS = readHarness("runner");

describe("multi-mode runner under lute", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should pass the runner harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, {
			__CAPTURE_MODULE__: readLuauModule("game-output-capture.luau"),
			__INFINITE_YIELD_MODULE__: readLuauModule("infinite-yield.luau"),
			__INTERCEPT_WRITEABLE_MODULE__: readLuauModule("intercept-writeable.luau"),
			__LAST_SEEN_MODULE__: inlineRequires(readLuauModule("last-seen.luau"), [
				"circus-hook",
				"data-model-path",
			]),
			__MODULE__: readLuauModule("runner.luau"),
			__PROCESS_CAPTURE_MODULE__: readLuauModule("process-capture.luau"),
			__RUNNER_RESULT_MODULE__: readLuauModule("runner-result.luau"),
		});

		expect(spawnHarness("runner-", script)).toContain("ALL OK");
	});
});
