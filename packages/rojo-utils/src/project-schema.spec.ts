import { describe, expect, it } from "vitest";

import { getTreeSchema } from "./project-schema.ts";

describe(getTreeSchema, () => {
	it("should preserve valid metadata and reject invalid roots and optional mounts", () => {
		expect.assertions(4);

		const tree = {
			$className: "DataModel",
			$ignoreUnknownInstances: true,
			$path: { optional: "src" },
			$properties: { Name: "Root" },
			Child: false,
		};

		expect(getTreeSchema()(tree)).toStrictEqual(tree);
		expect(getTreeSchema()).toBe(getTreeSchema());
		expect(getTreeSchema()([])).toHaveProperty("summary", "must be an object (was an array)");
		expect(getTreeSchema()({ $path: { optional: false } })).toHaveProperty("summary");
	});

	it.for([
		[],
		null,
		{ $className: 42 },
		{ $ignoreUnknownInstances: "yes" },
		{ $path: { optional: 42 } },
		{ $properties: false },
	])("should reject invalid tree metadata %j", (value) => {
		expect.assertions(1);

		expect(getTreeSchema()(value)).toHaveProperty("summary");
	});
});
