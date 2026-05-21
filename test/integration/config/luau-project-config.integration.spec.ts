import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadProjectConfigFile } from "../../../src/config/projects.ts";

const USER_AUTHORED_FIXTURE_PATH = path.resolve(
	__dirname,
	"../../e2e/fixtures/user-authored-config",
);

describe("string-entry resolution of user-authored jest.config.luau", () => {
	it("should preserve string-valued fields when loading a real Luau config via Lute", async () => {
		expect.assertions(2);

		const config = await loadProjectConfigFile("src/b", USER_AUTHORED_FIXTURE_PATH);

		expect(config.displayName).toBe("b-user");
		expect(config.testMatch).toStrictEqual(["**/*.spec"]);
	});
});
