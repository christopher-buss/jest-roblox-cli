import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import type { JestResult } from "../types/jest-result.ts";
import { MINIMAL_RESULT } from "./__fixtures__/results.ts";
import { formatJson, writeJsonFileAsync } from "./json.ts";

describe(formatJson, () => {
	it("should return formatted JSON string", () => {
		expect.assertions(1);

		const result: JestResult = {
			numFailedTests: 0,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: 1000,
			success: true,
			testResults: [],
		};

		const json = formatJson(result);

		expect(json).toBe(JSON.stringify(result, null, 2));
	});
});

describe(writeJsonFileAsync, () => {
	it("should write JSON to file", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const temporaryDirectory = path.resolve("fixture");

		const result: JestResult = {
			numFailedTests: 0,
			numPassedTests: 2,
			numPendingTests: 0,
			numTotalTests: 2,
			startTime: 0,
			success: true,
			testResults: [],
		};

		const filePath = path.join(temporaryDirectory, "results.json");
		await writeJsonFileAsync({ filePath, fileSystem, result });

		const content = fileSystem.readFileSync(filePath, "utf8");

		expect(content).toBe(formatJson(result));
	});

	it("should create parent directories if needed", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const temporaryDirectory = path.resolve("fixture");

		const result: JestResult = {
			numFailedTests: 0,
			numPassedTests: 0,
			numPendingTests: 0,
			numTotalTests: 0,
			startTime: 0,
			success: true,
			testResults: [],
		};

		const filePath = path.join(temporaryDirectory, "nested", "deep", "results.json");
		await writeJsonFileAsync({ filePath, fileSystem, result });

		expect(fileSystem.existsSync(filePath)).toBeTrue();
	});
});

describe("formatJson snapshots", () => {
	it("should format result as JSON", () => {
		expect.assertions(1);

		const output = formatJson(MINIMAL_RESULT);

		expect(output).toMatchInlineSnapshot(`
			"{
			  "numFailedTests": 1,
			  "numPassedTests": 1,
			  "numPendingTests": 0,
			  "numTotalTests": 2,
			  "startTime": 1700000000000,
			  "success": false,
			  "testResults": [
			    {
			      "numFailingTests": 1,
			      "numPassingTests": 1,
			      "numPendingTests": 0,
			      "testFilePath": "src/test.spec.ts",
			      "testResults": [
			        {
			          "ancestorTitles": [
			            "TestSuite"
			          ],
			          "duration": 10,
			          "failureMessages": [],
			          "fullName": "Test passes",
			          "status": "passed",
			          "title": "passes"
			        },
			        {
			          "ancestorTitles": [
			            "TestSuite"
			          ],
			          "duration": 10,
			          "failureMessages": [
			            "Expected: 1\\nReceived: 2"
			          ],
			          "fullName": "Test fails",
			          "status": "failed",
			          "title": "fails"
			        }
			      ]
			    }
			  ]
			}"
		`);
	});
});
