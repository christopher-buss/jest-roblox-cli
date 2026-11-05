import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_DIR = path.resolve(__dirname, "..", "..");
const [CHECKER, CHECK] = ["lute", "check"] as const;

describe("shipped luau type test library", () => {
	it("should pass lute check with no diagnostics", () => {
		expect.assertions(1);

		const stdout = execFileSync(
			CHECKER,
			[CHECK, path.join(PACKAGE_DIR, "lib", "typecheck.luau")],
			{ cwd: PACKAGE_DIR, encoding: "utf8", timeout: 60_000, windowsHide: true },
		);

		expect(stdout).toBe("");
	});
});
