import { spawnLute, writeTemporaryLuauScript } from "@isentinel/luau-ast";

import fs from "node:fs";
import os from "node:os";
import { describe, it, type TestContext } from "vitest";

function makeScript(onTestFinished: TestContext["onTestFinished"]) {
	const scriptPath = writeTemporaryLuauScript({
		name: "luau-ast-process-test",
		source: 'print("package ready")',
	});
	onTestFinished(() => {
		fs.rmSync(scriptPath);
	});
	return { args: [], scriptPath };
}

describe("lute process", () => {
	it("should execute a temporary script through the package interface", ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(1);

		const options = makeScript(onTestFinished);

		expect(spawnLute(options)).toBe(`package ready${os.EOL}`);
	});
});
