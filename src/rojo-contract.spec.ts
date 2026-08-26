import { type } from "arktype";
import { describe, expect, it } from "vitest";

import { rojoProjectSchema } from "./types/rojo.ts";

describe(rojoProjectSchema, () => {
	it("should explain that an array is not a Rojo tree object", () => {
		expect.assertions(2);

		const result = rojoProjectSchema({ name: "project", tree: [] });

		expect(result).toBeInstanceOf(type.errors);
		expect(result).toHaveProperty("summary", "tree must be an object (was an array)");
	});
});
