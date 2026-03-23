import path from "node:path";
import { describe, expect, it } from "vitest";

import { runTypecheck } from "../src/typecheck/runner.ts";

const FIXTURE_DIR = path.resolve(__dirname, "fixtures", "typecheck");

describe("typecheck integration", () => {
	it("should pass all tests when file has no type errors", () => {
		expect.assertions(3);

		const result = runTypecheck({
			files: [path.join(FIXTURE_DIR, "passing.test-d.ts")],
			rootDir: FIXTURE_DIR,
			tsconfig: "tsconfig.json",
		});

		expect(result.success).toBeTrue();
		expect(result.numPassedTests).toBe(2);
		expect(result.numFailedTests).toBe(0);
	});

	it("should fail the test containing a type error", () => {
		expect.assertions(4);

		const result = runTypecheck({
			files: [path.join(FIXTURE_DIR, "failing.test-d.ts")],
			rootDir: FIXTURE_DIR,
			tsconfig: "tsconfig.json",
		});

		expect(result.success).toBeFalse();
		expect(result.numFailedTests).toBe(1);
		expect(result.numPassedTests).toBe(1);

		const failedTest = result.testResults[0]!.testResults.find((tc) => tc.status === "failed");

		expect(failedTest!.title).toBe("should reject string as number");
	});

	it("should handle mixed files with passing and failing", () => {
		expect.assertions(3);

		const result = runTypecheck({
			files: [
				path.join(FIXTURE_DIR, "passing.test-d.ts"),
				path.join(FIXTURE_DIR, "failing.test-d.ts"),
			],
			rootDir: FIXTURE_DIR,
			tsconfig: "tsconfig.json",
		});

		expect(result.success).toBeFalse();
		expect(result.numPassedTests).toBe(3);
		expect(result.numFailedTests).toBe(1);
	});

	it("should include TS error code in failure message", () => {
		expect.assertions(1);

		const result = runTypecheck({
			files: [path.join(FIXTURE_DIR, "failing.test-d.ts")],
			rootDir: FIXTURE_DIR,
			tsconfig: "tsconfig.json",
		});

		const failedTest = result.testResults[0]!.testResults.find((tc) => tc.status === "failed");

		expect(failedTest!.failureMessages[0]).toContain("TS2322");
	});

	it("should report correct test file path", () => {
		expect.assertions(1);

		const result = runTypecheck({
			files: [path.join(FIXTURE_DIR, "passing.test-d.ts")],
			rootDir: FIXTURE_DIR,
			tsconfig: "tsconfig.json",
		});

		expect(result.testResults[0]!.testFilePath).toContain("passing.test-d.ts");
	});
});
