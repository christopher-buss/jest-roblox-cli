import { describe, it } from "vitest";

import { RUNNER_KEYS } from "./runner.ts";

describe("rUNNER_KEYS", () => {
	it("should list every runner key, sorted", ({ expect }) => {
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
