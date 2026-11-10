import { describe, expect, it } from "vitest";

import { plural } from "./plural.ts";

describe(plural, () => {
	it("should keep the singular for exactly one", () => {
		expect.assertions(1);

		expect(plural(1, "file")).toBe("file");
	});

	it("should add an s for any other count", () => {
		expect.assertions(2);

		expect(plural(0, "file")).toBe("files");
		expect(plural(2, "file")).toBe("files");
	});

	it("should use the given plural form", () => {
		expect.assertions(1);

		expect(plural(3, ["pass", "passes"])).toBe("passes");
	});
});
