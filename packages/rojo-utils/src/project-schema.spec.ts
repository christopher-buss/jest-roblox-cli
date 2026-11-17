import { describe, expect, it } from "vitest";

import { treeSchema } from "./project-schema.ts";

describe("treeSchema", () => {
	it("should preserve valid metadata and reject invalid roots and optional mounts", () => {
		expect.assertions(3);

		const tree = {
			$className: "DataModel",
			$ignoreUnknownInstances: true,
			$path: { optional: "src" },
			$properties: { Name: "Root" },
			Child: false,
		};

		expect(treeSchema(tree)).toStrictEqual(tree);
		expect(treeSchema([])).toHaveProperty("summary", "must be an object (was an array)");
		expect(treeSchema({ $path: { optional: false } })).toHaveProperty("summary");
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

		expect(treeSchema(value)).toHaveProperty("summary");
	});
});
