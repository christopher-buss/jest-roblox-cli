import { describe, expect, it } from "vitest";

import { nodeFileSystem } from "./file-system.ts";

describe("nodeFileSystem", () => {
	it("should expose the synchronous disk adapter", () => {
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
