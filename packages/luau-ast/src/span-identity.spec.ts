import { describe, expect, it } from "vitest";

import type { LuauSpan } from "./ast.ts";
import { bindingKey } from "./span-identity.ts";

function span(overrides: Partial<LuauSpan>): LuauSpan {
	return {
		beginColumn: 1,
		beginLine: 1,
		endColumn: 1,
		endLine: 1,
		...overrides,
	};
}

describe(bindingKey, () => {
	it("should key a declaration by its begin position", () => {
		expect.assertions(1);

		expect(bindingKey(span({ beginColumn: 7, beginLine: 4 }))).toBe("4:7");
	});

	it("should tell two declarations on the same line apart", () => {
		expect.assertions(1);

		expect(bindingKey(span({ beginColumn: 7, beginLine: 4 }))).not.toBe(
			bindingKey(span({ beginColumn: 14, beginLine: 4 })),
		);
	});
});
