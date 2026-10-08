import { describe, expect, it } from "vitest";

import { numberNode } from "#test/helpers/unit/cst";
import { createCstEdits } from "./cst-edit.ts";

describe(createCstEdits, () => {
	it("should reject a second replacement naming both callers", () => {
		expect.assertions(1);

		const target = numberNode();
		const edits = createCstEdits();
		edits.replace({ caller: "first", replacement: { text: "2" }, target });

		expect(() => {
			edits.replace({ caller: "second", replacement: { text: "3" }, target });
		}).toThrow("second cannot replace the Number at 1:1: first already replaced it");
	});
});
