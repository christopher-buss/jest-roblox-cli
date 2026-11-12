import { describe, expect, it } from "vitest";

import { nodeChildProcessRunner } from "./child-process.ts";

describe("nodeChildProcessRunner", () => {
	it("should launch through node:child_process", () => {
		expect.assertions(3);

		expect(() => nodeChildProcessRunner.execFile("git")).toThrow(/\(execFile\)/);
		expect(() => nodeChildProcessRunner.execFileSync("git")).toThrow(/\(execFileSync\)/);
		expect(() => nodeChildProcessRunner.spawn("git")).toThrow(/\(spawn\)/);
	});
});
