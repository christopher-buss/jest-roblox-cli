import { describe, expect, it } from "vitest";

import { composeEntryDisplayName } from "./display-name.ts";

describe(composeEntryDisplayName, () => {
	it("should name the project alone when the run has no package", () => {
		expect.assertions(1);

		expect(composeEntryDisplayName(undefined, "client")).toBe("client");
	});

	it("should name the project alone when the package shares its name", () => {
		expect.assertions(1);

		expect(composeEntryDisplayName("core", "core")).toBe("core");
	});

	it("should name the package, then the project", () => {
		expect.assertions(1);

		expect(composeEntryDisplayName("core", "client")).toBe("core › client");
	});
});
