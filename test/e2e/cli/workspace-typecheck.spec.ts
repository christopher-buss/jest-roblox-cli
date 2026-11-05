/**
 * E2e — workspace `--typecheckOnly`.
 *
 * Drives the real CLI binary through config-load → discovery → classification
 * → grouping → real tsgo → result-merge → exit-code, in workspace mode.
 * Pure-local tsgo: no rojo build, no Open Cloud, no secrets — so this lives in
 * the default `e2e` project (not the rojo/live-gated ones).
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
	createFixtureSandbox,
	readMergedTestFilePaths,
	runCliAsync,
} from "#test/e2e/cli/helpers.ts";

const WORKSPACE_FIXTURE = path.resolve(__dirname, "../fixtures/workspace");

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

		const paths = readMergedTestFilePaths(outputFile);
		const hasTypedResult = paths.some((filePath) => filePath.includes("@e2e/typed/"));

		expect(hasTypedResult).toBeTrue();
	});

	// The mixed run carries the failure reporting too. A broken package on its
	// own used to have a test of its own, but it drives the same tsgo spawn and
	// prints the same diagnostics — nothing about the failure path is specific
	// to running the broken package alone.
	it("should group type tests per package and name the failing one with its TS code", async () => {
		expect.assertions(5);

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

		const output = result.stdout + result.stderr;

		// typed passes, typed-broken fails — the run fails overall, but BOTH
		// packages' type tests are reported under their own package identity.
		expect(result.exitCode).toBe(1);
		expect(output).toContain("should reject a string assigned to number");
		expect(output).toMatch(/TS\d+/);

		const paths = readMergedTestFilePaths(outputFile);

		expect(paths.some((filePath) => filePath.includes("@e2e/typed/"))).toBeTrue();
		expect(paths.some((filePath) => filePath.includes("@e2e/typed-broken/"))).toBeTrue();
	});

	it("should stamp each luau package's type tests with its identity and fail on the broken one", async () => {
		expect.assertions(4);

		const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE);
		const outputFile = path.join(sandbox, "luau-result.json");

		const result = await runCliAsync(
			[
				"--workspace",
				"--packages=@e2e/luau-typed,@e2e/luau-typed-broken",
				"--typecheckOnly",
				"--outputFile",
				outputFile,
			],
			{ cwd: sandbox },
		);

		expect(result.exitCode).toBe(1);
		expect(result.stdout + result.stderr).toContain("rejects a string field");

		const paths = readMergedTestFilePaths(outputFile);

		expect(paths.some((filePath) => filePath.includes("@e2e/luau-typed/"))).toBeTrue();
		expect(paths.some((filePath) => filePath.includes("@e2e/luau-typed-broken/"))).toBeTrue();
	});

	it("should exit 0 when a luau package's type tests pass", async () => {
		expect.assertions(1);

		const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE);

		const result = await runCliAsync(
			["--workspace", "--packages=@e2e/luau-typed", "--typecheckOnly"],
			{ cwd: sandbox },
		);

		expect(result.exitCode).toBe(0);
	});
});
