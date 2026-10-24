import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createFixtureSandbox, readMergedTestFilePaths, runCliAsync } from "./helpers.ts";

const SINGLE_FIXTURE = path.resolve(__dirname, "../fixtures/typecheck-luau-single");
const SINGLE_BROKEN_FIXTURE = path.resolve(__dirname, "../fixtures/typecheck-luau-single-broken");
const MULTI_FIXTURE = path.resolve(__dirname, "../fixtures/typecheck-luau-multi");
const MIXED_FIXTURE = path.resolve(__dirname, "../fixtures/typecheck-mixed");

describe("single luau --typecheckOnly e2e", () => {
	it("should check luau type tests with lute and exit 0 when they pass", async () => {
		expect.assertions(2);

		const sandbox = createFixtureSandbox(SINGLE_FIXTURE);

		const result = await runCliAsync(["--typecheckOnly"], { cwd: sandbox });

		expect(result.exitCode).toBe(0);
		expect(result.stdout + result.stderr).toContain("2 passed");
	});

	it("should report the failing luau type test by name and message", async () => {
		expect.assertions(3);

		const sandbox = createFixtureSandbox(SINGLE_BROKEN_FIXTURE);

		const result = await runCliAsync(["--typecheckOnly"], { cwd: sandbox });

		const output = result.stdout + result.stderr;

		expect(result.exitCode).toBe(1);
		expect(output).toContain("rejects a string field");
		expect(output).toContain("TypeError");
	});
});

describe("multi luau --typecheckOnly e2e", () => {
	it("should check every project's luau type tests and merge the results", async () => {
		expect.assertions(5);

		const sandbox = createFixtureSandbox(MULTI_FIXTURE);
		const outputFile = path.join(sandbox, "typecheck-result.json");

		const result = await runCliAsync(["--typecheckOnly", "--outputFile", outputFile], {
			cwd: sandbox,
		});

		const output = result.stdout + result.stderr;

		expect(result.exitCode).toBe(1);
		expect(output).toContain("rejects a string field");
		expect(output).toContain("3 passed");

		const paths = readMergedTestFilePaths(outputFile);

		expect(paths.some((filePath) => filePath.includes("alpha"))).toBeTrue();
		expect(paths.some((filePath) => filePath.includes("beta"))).toBeTrue();
	});
});

describe("mixed-language --typecheckOnly e2e", () => {
	it("should check typescript and luau type tests in one pass and merge the counts", async () => {
		expect.assertions(4);

		const sandbox = createFixtureSandbox(MIXED_FIXTURE);
		const outputFile = path.join(sandbox, "typecheck-result.json");

		const result = await runCliAsync(["--typecheckOnly", "--outputFile", outputFile], {
			cwd: sandbox,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout + result.stderr).toContain("3 passed");

		const paths = readMergedTestFilePaths(outputFile);

		expect(paths.some((filePath) => filePath.endsWith("index.spec-d.ts"))).toBeTrue();
		expect(paths.some((filePath) => filePath.endsWith("point.spec-d.luau"))).toBeTrue();
	});
});
