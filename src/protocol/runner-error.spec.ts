import { describe, expect, it } from "vitest";

import { RUNNER_TIMEOUT_FORMAT } from "./runner-error.ts";

describe("runner error protocol", () => {
	it("should leave one seconds slot in the timeout message", () => {
		expect.assertions(1);

		expect(RUNNER_TIMEOUT_FORMAT.split("%g")).toHaveLength(2);
	});
});
