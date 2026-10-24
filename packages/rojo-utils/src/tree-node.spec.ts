import { describe, expect, it } from "vitest";

import { isOptionalPath, isRojoTreeNode, unwrapPath } from "./tree-node.ts";

describe(isRojoTreeNode, () => {
	it.for([undefined, null, false, "child", 3, []])("should reject a non-node %j", (value) => {
		expect.assertions(1);

		expect(isRojoTreeNode(value)).toBeFalse();
	});

	it("should accept a metadata-bearing child object", () => {
		expect.assertions(1);

		expect(isRojoTreeNode({ $className: "Folder" })).toBeTrue();
	});
});

describe(isOptionalPath, () => {
	it.for([{}, { optional: false }, "src", undefined])(
		"should reject a non-optional mount %j",
		(value) => {
			expect.assertions(1);

			expect(isOptionalPath(value)).toBeFalse();
		},
	);

	it("should retain even an empty optional path", () => {
		expect.assertions(2);

		expect(isOptionalPath({ optional: "" })).toBeTrue();
		expect(unwrapPath({ optional: "src" })).toBe("src");
	});
});

describe(unwrapPath, () => {
	it("should distinguish string paths, optional paths and absent mounts", () => {
		expect.assertions(3);

		expect(unwrapPath("src")).toBe("src");
		expect(unwrapPath({ optional: "" })).toBe("");
		expect(unwrapPath({ $className: "Folder" })).toBeUndefined();
	});
});
