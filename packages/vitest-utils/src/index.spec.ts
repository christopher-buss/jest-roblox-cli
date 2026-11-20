import { describe, it } from "vitest";

import * as utilities from "./index.ts";

describe("package interface", () => {
	it("should expose the shared test helpers", ({ expect }) => {
		expect.assertions(1);

		expect(Object.keys(utilities).sort()).toStrictEqual(["createMemoryFileSystem"]);
	});
});
