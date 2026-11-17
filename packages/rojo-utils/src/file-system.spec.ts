import { describe, it } from "vitest";

import { nodeFileSystem } from "./file-system.ts";

describe("nodeFileSystem", () => {
	it("should expose the synchronous disk adapter", ({ expect }) => {
		expect.assertions(1);

		expect(nodeFileSystem).toContainKeys([
			"existsSync",
			"readdirSync",
			"readFileSync",
			"realpathSync",
			"statSync",
		]);
	});
});
