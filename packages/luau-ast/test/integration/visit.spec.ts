import { loadLuauParser, visitBlock } from "@isentinel/luau-ast";

import { assert, describe, expect, it } from "vitest";

describe("parser and visitor", () => {
	it("should traverse parsed expressions in lexical order", () => {
		expect.assertions(1);

		const parsed = loadLuauParser().parse("local x = 1 + 2\nreturn x");
		assert(parsed.ok);
		const events: Array<number | string> = [];

		visitBlock(parsed.root, {
			visitExprConstantNumber: ({ value }) => {
				events.push(value);
				return true;
			},
			visitExprLocal: ({ local }) => {
				events.push(local.name);
				return true;
			},
		});

		expect(events).toStrictEqual([1, 2, "x"]);
	});
});
