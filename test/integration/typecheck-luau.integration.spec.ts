import path from "node:path";
import { describe, expect, it } from "vitest";

import { runTypecheckAsync } from "../../src/typecheck/runner.ts";

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "typecheck-luau");

async function checkAsync(fileName: string, ignoreSourceErrors = false) {
	return runTypecheckAsync({
		files: [path.join(FIXTURE_DIR, fileName)],
		ignoreSourceErrors,
		rootDir: FIXTURE_DIR,
	});
}

describe("luau typecheck integration", () => {
	it("should pass every it in a clean spec", async () => {
		expect.assertions(2);

		const result = await checkAsync("passing.spec-d.luau");

		expect(result.success).toBeTrue();
		expect(result.numPassedTests).toBe(2);
	});

	it("should fail the it holding a type error with lute's message", async () => {
		expect.assertions(2);

		const result = await checkAsync("failing.spec-d.luau");

		const cases = result.testResults[0]!.testResults;

		expect(cases.map(({ fullName, status }) => [fullName, status])).toStrictEqual([
			["Point > accepts numeric fields", "passed"],
			["Point > rejects a string field", "failed"],
		]);
		expect(cases[1]!.failureMessages).toStrictEqual([
			"TypeError: Expected this to be 'number', but got 'string'",
		]);
	});

	it("should fail the file for an error outside every it", async () => {
		expect.assertions(2);

		const result = await checkAsync("file-level.spec-d.luau");

		const [fileCase, passing] = result.testResults[0]!.testResults;

		expect(fileCase!.title).toBe("<file-level type error>");
		expect(passing!.status).toBe("passed");
	});

	it("should report an error in a required source file", async () => {
		expect.assertions(3);

		const result = await checkAsync("uses-source.spec-d.luau");

		const sourceResult = result.testResults.find(
			({ testFilePath }) => testFilePath === "source.luau",
		);

		expect(result.success).toBeFalse();
		expect(sourceResult!.testResults[0]!.title).toBe("<source type error>");
		expect(sourceResult!.testResults[0]!.failureMessages[0]).toContain("TypeError");
	});

	it("should drop source errors when ignoreSourceErrors is set", async () => {
		expect.assertions(2);

		const result = await checkAsync("uses-source.spec-d.luau", true);

		expect(result.success).toBeTrue();
		expect(result.testResults).toHaveLength(1);
	});

	it("should fail a spec without --!strict", async () => {
		expect.assertions(2);

		const result = await checkAsync("nonstrict.spec-d.luau");

		const [fileCase] = result.testResults[0]!.testResults;

		expect(result.success).toBeFalse();
		expect(fileCase!.failureMessages[0]).toContain("--!strict");
	});

	it("should fail a spec that does not parse with the parser message", async () => {
		expect.assertions(2);

		const result = await checkAsync("broken.spec-d.luau");

		const [fileCase] = result.testResults[0]!.testResults;

		expect(fileCase!.title).toBe("<file-level type error>");
		expect(fileCase!.failureMessages).toStrictEqual([
			expect.stringMatching(/^SyntaxError: .*Expected/),
		]);
	});

	it("should pass an it whose type error an @expect-error consumes", async () => {
		expect.assertions(2);

		const result = await checkAsync("expect-error.spec-d.luau");

		expect(result.success).toBeTrue();
		expect(result.numPassedTests).toBe(1);
	});

	it("should fail the it holding an unused @expect-error", async () => {
		expect.assertions(2);

		const result = await checkAsync("expect-error-unused.spec-d.luau");

		const [testCase] = result.testResults[0]!.testResults;

		expect(testCase!.fullName).toBe("expects an error that never comes");
		expect(testCase!.failureMessages).toStrictEqual(["ExpectError: unused @expect-error"]);
	});
});
