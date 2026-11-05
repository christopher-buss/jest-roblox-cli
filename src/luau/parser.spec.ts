import { assert, describe, expect, it } from "vitest";

import { luauParser } from "./parser.ts";

describe("luauParser", () => {
	it("should parse Luau source into a statement block", () => {
		expect.assertions(1);

		const parsed = luauParser.parse("local value: number = 1\nreturn value\n");
		assert(parsed.ok);

		expect(parsed.root.body).toHaveLength(2);
	});

	it("should report source that does not parse", () => {
		expect.assertions(1);

		expect(luauParser.parse("local = ").ok).toBeFalse();
	});
});
