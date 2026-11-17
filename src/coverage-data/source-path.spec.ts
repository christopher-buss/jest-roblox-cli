import { describe, it } from "vitest";

import { resolveSourcePath } from "./source-path.ts";

describe(resolveSourcePath, () => {
	it("should anchor a parent-relative source to the sidecar directory", ({ expect }) => {
		expect.assertions(1);

		expect(resolveSourcePath("../src/a.ts", "out/shared")).toBe("out/src/a.ts");
	});

	it("should normalize Windows separators before anchoring", ({ expect }) => {
		expect.assertions(1);

		expect(resolveSourcePath("..\\src\\a.ts", "out/shared")).toBe("out/src/a.ts");
	});

	it("should keep any other source as written", ({ expect }) => {
		expect.assertions(1);

		expect(resolveSourcePath("src/a.ts", "out/shared")).toBe("src/a.ts");
	});
});
