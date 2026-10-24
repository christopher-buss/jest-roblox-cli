import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createFixtureSandbox, runCliAsync } from "./helpers.ts";

const LIBRARY_FIXTURE = path.resolve(__dirname, "../fixtures/typecheck-luau-library");
const LIBRARY_BROKEN_FIXTURE = path.resolve(__dirname, "../fixtures/typecheck-luau-library-broken");
const LIBRARY_DIR = path.resolve(__dirname, "../../../lib");

function createLibrarySandbox(fixture: string): string {
	const sandbox = createFixtureSandbox(fixture);
	writeFileSync(
		path.join(sandbox, ".luaurc"),
		JSON.stringify({ aliases: { jest: LIBRARY_DIR }, languageMode: "strict" }),
	);
	return sandbox;
}

describe("shipped luau library --typecheckOnly e2e", () => {
	it("should pass every matcher case in the fixture suite", async () => {
		expect.assertions(2);

		const sandbox = createLibrarySandbox(LIBRARY_FIXTURE);

		const result = await runCliAsync(["--typecheckOnly"], { cwd: sandbox });

		expect(result.exitCode).toBe(0);
		expect(result.stdout + result.stderr).toContain("113 passed");
	});

	it("should report a failing equality as expected and received types", async () => {
		expect.assertions(4);

		const sandbox = createLibrarySandbox(LIBRARY_BROKEN_FIXTURE);

		const result = await runCliAsync(["--typecheckOnly"], { cwd: sandbox });

		const output = result.stdout + result.stderr;

		expect(result.exitCode).toBe(1);
		expect(output).toContain("has numeric fields");
		expect(output).toContain("Expected: { x: number, y: string }");
		expect(output).toContain("Received: { x: number, y: number }");
	});
});
