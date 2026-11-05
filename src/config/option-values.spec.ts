import { describe, expect, it } from "vitest";

import { isValidBackend } from "./option-values.ts";

describe(isValidBackend, () => {
	it("should return true for valid backends", () => {
		expect.assertions(4);

		expect(isValidBackend("auto")).toBeTrue();
		expect(isValidBackend("open-cloud")).toBeTrue();
		expect(isValidBackend("studio")).toBeTrue();
		expect(isValidBackend("studio-cli")).toBeTrue();
	});

	it("should return false for invalid backends", () => {
		expect.assertions(2);

		expect(isValidBackend("invalid")).toBeFalse();
		expect(isValidBackend("")).toBeFalse();
	});
});
