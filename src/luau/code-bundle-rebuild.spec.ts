import { describe, expect, it } from "vitest";

import harnessSource from "../../luau/code-bundle-rebuild.luau";
import { CODE_BUNDLE_REBUILD_SOURCE } from "./code-bundle-rebuild.ts";

describe("the code bundle rebuild source", () => {
	it("should be the module the lute harness runs", () => {
		expect.assertions(2);

		expect(harnessSource).toContain("BinaryInput");
		expect(CODE_BUNDLE_REBUILD_SOURCE).toBe(harnessSource);
	});
});
