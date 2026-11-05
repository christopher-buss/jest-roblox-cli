import process from "node:process";
import { describe, expect, it } from "vitest";

import { nodeChildProcessRunner } from "./child-process.ts";

describe("nodeChildProcessRunner", () => {
	it("should launch a real child process", () => {
		expect.assertions(1);

		const output = nodeChildProcessRunner.execFileSync(
			process.execPath,
			["-e", "process.stdout.write('ok')"],
			{ encoding: "utf-8" },
		);

		expect(output).toBe("ok");
	});
});
