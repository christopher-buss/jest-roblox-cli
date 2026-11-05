import { describe, expect, it } from "vitest";

import { projectKey } from "./project-key.ts";

describe(projectKey, () => {
	it("should give the same key for the same pair", () => {
		expect.assertions(1);

		expect(projectKey("core", "shared")).toBe(projectKey("core", "shared"));
	});

	it("should keep projects of the same name in different packages apart", () => {
		expect.assertions(1);

		expect(projectKey("core", "shared")).not.toBe(projectKey("ui", "shared"));
	});

	it("should not let a separator in one segment collide with another pair", () => {
		expect.assertions(1);

		expect(projectKey("a,b", "c")).not.toBe(projectKey("a", "b,c"));
	});
});
