import path from "node:path";
import { describe, expect, it } from "vitest";

import { spawnLuauCheckAsync } from "../../src/typecheck/luau-check.ts";
import { parseLuauOutput } from "../../src/typecheck/luau-parse.ts";
import { nodeChildProcessRunner } from "../../src/utils/child-process.ts";

const PACKAGE_DIR = path.resolve(__dirname, "..", "..");

describe("shipped luau type test library", () => {
	it("should pass lute check with no diagnostics", async () => {
		expect.assertions(1);

		const stdout = await spawnLuauCheckAsync({
			childProcess: nodeChildProcessRunner,
			files: [path.join(PACKAGE_DIR, "lib", "typecheck.luau")],
			rootDir: PACKAGE_DIR,
			runTimeout: 60_000,
			spawnTimeout: 10_000,
		});

		expect(parseLuauOutput(stdout)).toBeEmpty();
	});
});
