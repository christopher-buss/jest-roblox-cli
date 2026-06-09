/**
 * E2e — workspace `--typecheckOnly`.
 *
 * Drives the real CLI binary through config-load → discovery → classification →
 * grouping → real tsgo → result-merge → exit-code, in workspace mode. Pure-local
 * tsgo: no rojo build, no Open Cloud, no secrets — so this lives in the default
 * `e2e` project (not the rojo/live-gated ones).
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createFixtureSandbox, readJsonSync, runCliAsync } from "./helpers.ts";

const WORKSPACE_FIXTURE = path.resolve(__dirname, "../fixtures/workspace");

interface MergedResult {
	testResults: Array<{ testFilePath: string }>;
}

describe("workspace --typecheckOnly e2e", () => {
	it("should run a package's type tests and exit 0 when they pass", async () => {
		expect.assertions(2);

		const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE);
		const outputFile = path.join(sandbox, "typed-result.json");

		const result = await runCliAsync(
			["--workspace", "--packages=@e2e/typed", "--typecheckOnly", "--outputFile", outputFile],
			{ cwd: sandbox },
		);

		expect(result.exitCode).toBe(0);

		const merged = readJsonSync(outputFile) as MergedResult;
		const composed = merged.testResults.some((file) =>
			file.testFilePath.includes("@e2e/typed/"),
		);

		expect(composed).toBeTrue();
	});

	it("should exit 1 and name the failing type test with its TS code", async () => {
		expect.assertions(3);

		const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE);

		const result = await runCliAsync(
			["--workspace", "--packages=@e2e/typed-broken", "--typecheckOnly"],
			{ cwd: sandbox },
		);

		const output = result.stdout + result.stderr;

		expect(result.exitCode).toBe(1);
		expect(output).toContain("should reject a string assigned to number");
		expect(output).toMatch(/TS\d+/);
	});

	it("should group type tests per package with package-composed identity", async () => {
		expect.assertions(3);

		const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE);
		const outputFile = path.join(sandbox, "grouped-result.json");

		const result = await runCliAsync(
			[
				"--workspace",
				"--packages=@e2e/typed,@e2e/typed-broken",
				"--typecheckOnly",
				"--outputFile",
				outputFile,
			],
			{ cwd: sandbox },
		);

		// typed passes, typed-broken fails — the run fails overall, but BOTH
		// packages' type tests are reported under their own package identity.
		expect(result.exitCode).toBe(1);

		const merged = readJsonSync(outputFile) as MergedResult;
		const paths = merged.testResults.map((file) => file.testFilePath);

		expect(paths.some((filePath) => filePath.includes("@e2e/typed/"))).toBeTrue();
		expect(paths.some((filePath) => filePath.includes("@e2e/typed-broken/"))).toBeTrue();
	});
});
