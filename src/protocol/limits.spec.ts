import { describe, expect, it } from "vitest";

import { RESULT_BUDGET_BYTES } from "./limits.ts";

const OPEN_CLOUD_RETURN_CAP_BYTES = 4 * 1024 * 1024;

describe("rESULT_BUDGET_BYTES", () => {
	it("should stay under Open Cloud's return cap", () => {
		expect.assertions(1);

		expect(RESULT_BUDGET_BYTES).toBeLessThan(OPEN_CLOUD_RETURN_CAP_BYTES);
	});
});
