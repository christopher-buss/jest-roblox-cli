import { describe, expect, it } from "vitest";

import { createToken, isToken } from "./cst-token.ts";

describe(createToken, () => {
	it("should retain a token's spelling and source span", () => {
		expect.assertions(1);

		const origin = { beginColumn: 2, beginLine: 1, endColumn: 3, endLine: 1 };

		expect(createToken("x", origin)).toStrictEqual({
			leading: [],
			origin,
			text: "x",
			trailing: [],
		});
	});
});

describe(isToken, () => {
	it("should accept a created token", () => {
		expect.assertions(1);

		expect(
			isToken(createToken("x", { beginColumn: 1, beginLine: 1, endColumn: 2, endLine: 1 })),
		).toBeTrue();
	});

	it.for([
		{ expected: false, value: undefined },
		{ expected: false, value: null },
		{ expected: false, value: "token" },
		{ expected: false, value: [] },
		{ expected: false, value: {} },
		{ expected: false, value: { text: 1 } },
		{ expected: false, value: { text: "x" } },
	])(
		"should recognize $value as a token only when its text is a string",
		({ expected, value }) => {
			expect.assertions(1);

			expect(isToken(value)).toBe(expected);
		},
	);

	it("should reject a token whose text is not a string even when its trivia lists are valid", () => {
		expect.assertions(1);

		expect(isToken({ leading: [], text: 0, trailing: [] })).toBeFalse();
	});
});
