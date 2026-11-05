import path from "node:path";
import { describe, expect, it } from "vitest";

import { runTypecheckAsync } from "../../src/index.ts";

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "luau-config-type");

async function checkAsync(fileName: string) {
	return runTypecheckAsync({
		files: [path.join(FIXTURE_DIR, fileName)],
		rootDir: FIXTURE_DIR,
	});
}

describe("luau config type checks", () => {
	it("should accept valid configs", async () => {
		expect.assertions(2);

		const result = await checkAsync("valid.spec-d.luau");

		expect(result.success).toBeTrue();
		expect(result.numPassedTests).toBe(3);
	});

	it("should reject unknown keys and wrong value shapes", async () => {
		expect.assertions(2);

		const result = await checkAsync("invalid.spec-d.luau");

		expect(result.success).toBeTrue();
		expect(
			result.testResults[0]!.testResults.map(({ fullName, status }) => [fullName, status]),
		).toStrictEqual([
			["Config > rejects an unknown root key", "passed"],
			["Config > rejects an unknown test key", "passed"],
			["Config > rejects a backend that does not exist", "passed"],
			["Config > rejects a string where a list goes", "passed"],
			["Config > rejects a project without include", "passed"],
		]);
	});
});
