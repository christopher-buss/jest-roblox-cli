import { describe, expect, it } from "vitest";

import { createToken } from "./cst-token.ts";

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
