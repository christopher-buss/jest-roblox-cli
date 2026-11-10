import { describe, expect, it } from "vitest";

import { PREPARE_COVERAGE_SPAN, ROJO_BUILD_SPAN } from "./span-names.ts";

describe("span names", () => {
	it("should keep the names the timing report prints", () => {
		expect.assertions(2);

		expect(PREPARE_COVERAGE_SPAN).toBe("prepareCoverage");
		expect(ROJO_BUILD_SPAN).toBe("rojoBuild");
	});
});
