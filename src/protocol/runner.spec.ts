import { describe, expect, it } from "vitest";

import { RUNNER_KEYS } from "./runner.ts";

describe("rUNNER_KEYS", () => {
	it("should list every runner key, sorted", () => {
		expect.assertions(1);

		expect(RUNNER_KEYS).toStrictEqual([
			"runnerCaptureGameOutput",
			"runnerCoverage",
			"runnerJobIndex",
			"runnerPerTestCoverage",
			"runnerTimeoutMs",
			"runnerTiming",
		]);
	});
});
