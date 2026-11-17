import { describe, it } from "vitest";

import { RbxPathParent } from "./rbx-path.ts";

describe("rbxPathParent", () => {
	it("should distinguish parent traversal from named instances", ({ expect }) => {
		expect.assertions(2);

		expect(RbxPathParent.description).toBe("Parent");
		expect(Symbol.keyFor(RbxPathParent)).toBeUndefined();
	});
});
