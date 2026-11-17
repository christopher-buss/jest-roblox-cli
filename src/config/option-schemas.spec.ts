import { type } from "arktype";
import { describe, it } from "vitest";

import { absolutePathSchema, displayNameSchema } from "./option-schemas.ts";

describe("option schemas", () => {
	it("should accept only absolute paths", ({ expect }) => {
		expect.assertions(2);

		expect(absolutePathSchema("C:/Plugins")).toBe("C:/Plugins");
		expect(absolutePathSchema("plugins")).toBeInstanceOf(type.errors);
	});

	it("should accept a display name string or a coloured label", ({ expect }) => {
		expect.assertions(2);

		expect(displayNameSchema({ name: "a", color: "white" })).not.toBeInstanceOf(type.errors);
		expect(displayNameSchema({ name: "a" })).toBeInstanceOf(type.errors);
	});
});
