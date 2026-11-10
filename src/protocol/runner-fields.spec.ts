import { type } from "arktype";
import { describe, expect, it } from "vitest";

import { runnerFieldsSchema } from "./runner-fields.ts";

describe("runnerFieldsSchema", () => {
	it("should keep a field of any shape for the parser to judge", () => {
		expect.assertions(1);

		expect(runnerFieldsSchema({ code: 7, phase: "run" })).toStrictEqual({
			code: 7,
			phase: "run",
		});
	});

	it("should reject a runner value that is not an object", () => {
		expect.assertions(1);

		expect(runnerFieldsSchema("boom")).toBeInstanceOf(type.errors);
	});
});
