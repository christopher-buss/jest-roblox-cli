import { describe, expect, it } from "vitest";

import { numberNode } from "#test/helpers/unit/cst";
import { printCst } from "./cst-print.ts";

describe(printCst, () => {
	it("should print the supplied token spelling and trivia", () => {
		expect.assertions(1);

		const root = numberNode();
		root.token.leading.push({ kind: "comment", text: "-- value\n" });
		root.token.trailing.push({ kind: "whitespace", text: "\n" });

		expect(printCst(root)).toBe("-- value\n1\n");
	});
});
