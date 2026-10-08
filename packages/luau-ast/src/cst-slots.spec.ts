import { describe, expect, it } from "vitest";

import { punctuatedSlots } from "./cst-slots.ts";

describe(punctuatedSlots, () => {
	it("should visit a union separator before its member", () => {
		expect.assertions(2);

		expect(punctuatedSlots("TypeUnion")).toStrictEqual(["separator", "node"]);
		expect(punctuatedSlots("Call")).toStrictEqual(["node", "separator"]);
	});
});
