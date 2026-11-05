import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { isProperties, isTreeNode } from "./tree-node-guards.ts";

describe(isTreeNode, () => {
	it("should accept a node and reject an optional path or a scalar", () => {
		expect.assertions(3);

		expect(isTreeNode({ $path: "src" })).toBeTrue();
		expect(isTreeNode({ optional: "src" })).toBeFalse();
		expect(isTreeNode("src")).toBeFalse();
	});
});

describe(isProperties, () => {
	it("should accept only a plain object", () => {
		expect.assertions(3);

		expect(isProperties({ Name: "x" })).toBeTrue();
		expect(isProperties(fromAny(null))).toBeFalse();
		expect(isProperties(fromAny([]))).toBeFalse();
	});
});
