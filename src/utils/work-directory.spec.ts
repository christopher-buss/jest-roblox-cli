import { describe, it } from "vitest";

import { WORK_DIRECTORY } from "./work-directory.ts";

describe("work directory", () => {
	it("should be the dot-directory every artifact is written under", ({ expect }) => {
		expect.assertions(1);

		expect(WORK_DIRECTORY).toBe(".jest-roblox");
	});
});
