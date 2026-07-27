import { describe, expect, it } from "vitest";

import { isRojoTreeNode } from "./rojo-tree-node.ts";

describe(isRojoTreeNode, () => {
	it("should accept a nested node", () => {
		expect.assertions(2);

		expect(isRojoTreeNode({ $className: "Folder" })).toBeTrue();
		expect(isRojoTreeNode({})).toBeTrue();
	});

	it("should reject a non-object member", () => {
		expect.assertions(3);

		expect(isRojoTreeNode("src/shared")).toBeFalse();
		expect(isRojoTreeNode(true)).toBeFalse();
		expect(isRojoTreeNode(undefined)).toBeFalse();
	});

	it("should reject null", () => {
		expect.assertions(1);

		expect(isRojoTreeNode(null)).toBeFalse();
	});

	it("should reject an array", () => {
		expect.assertions(1);

		expect(isRojoTreeNode([])).toBeFalse();
	});
});
