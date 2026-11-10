import { type } from "arktype";
import { assert, describe, expect, it } from "vitest";

import { GLOBAL_TEST_ROWS } from "./test-options.ts";

function checkProject(test: object): unknown {
	const schema = GLOBAL_TEST_ROWS.find(({ key }) => key === "projects")?.schema;
	assert(schema !== undefined, "expected a projects schema");
	return schema([{ test }]);
}

describe("test options", () => {
	it("should require include and displayName in a project", () => {
		expect.assertions(2);

		expect(checkProject({ include: ["src/**"] })).toBeInstanceOf(type.errors);
		expect(checkProject({ displayName: "client", include: ["src/**"] })).not.toBeInstanceOf(
			type.errors,
		);
	});

	it("should leave the project-only root key out of the root test block", () => {
		expect.assertions(1);

		expect(GLOBAL_TEST_ROWS.map(({ key }) => key)).not.toContain("root");
	});
});
