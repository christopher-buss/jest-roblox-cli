import { spawnLute, writeTemporaryLuauScript } from "@isentinel/luau-ast";

import fs from "node:fs";
import os from "node:os";
import { describe, expect, it, onTestFinished } from "vitest";

function makeScript() {
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
	it("should execute a temporary script through the package interface", () => {
		expect.assertions(1);

		const options = makeScript();

		expect(spawnLute(options)).toBe(`package ready${os.EOL}`);
	});
});
