import { writeTemporaryLuauScript } from "@isentinel/luau-ast";

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

describe(writeTemporaryLuauScript, () => {
	it("should create a temporary script containing the supplied source", () => {
		expect.assertions(3);

		const scriptPath = writeTemporaryLuauScript("print('hello')", "luau-ast-standards-test");
		onTestFinished(() => {
			fs.rmSync(scriptPath);
		});

		expect(path.isAbsolute(scriptPath)).toBeTrue();
		expect(scriptPath).toMatch(/luau-ast-standards-test\.\d+\.luau$/);
		expect(fs.readFileSync(scriptPath, "utf8")).toBe("print('hello')");
	});
});
