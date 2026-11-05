import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { makeBlockedResult, makeExecuteResult, makeJestResult } from "#test/mocks/spec-results.ts";
import { mergeProjectResults, mergeResults } from "./output-merge.ts";
import type { TestFileResult } from "./types/jest-result-types.ts";

describe(mergeResults, () => {
	it("should reject when neither result dimension is present", () => {
		expect.assertions(1);

		expect(() => mergeResults(undefined, undefined)).toThrow(
			"mergeResults requires at least one result",
		);
	});

	it("should combine every aggregate field and preserve runtime snapshots", () => {
		expect.assertions(1);

		const typecheckFile = fromAny<TestFileResult, { testFilePath: string }>({
			testFilePath: "typecheck",
		});
		const runtimeFile = fromAny<TestFileResult, { testFilePath: string }>({
			testFilePath: "runtime",
		});
		const runtimeSnapshot = {
			added: 1,
			matched: 2,
			total: 4,
			unmatched: 1,
			updated: 0,
		};
		const typecheck = makeJestResult({
			numFailedTests: 1,
			numPassedTests: 2,
			numPendingTests: 3,
			numTodoTests: undefined,
			numTotalTests: 6,
			startTime: 1000,
			testResults: [typecheckFile],
		});
		const runtime = makeJestResult({
			numFailedTests: 4,
			numPassedTests: 5,
			numPendingTests: 6,
			numTodoTests: 7,
			numTotalTests: 22,
			snapshot: runtimeSnapshot,
			startTime: 2000,
			success: false,
			testResults: [runtimeFile],
		});

		expect(mergeResults(typecheck, runtime)).toStrictEqual({
			numFailedTests: 5,
			numPassedTests: 7,
			numPendingTests: 9,
			numTodoTests: 7,
			numTotalTests: 28,
			snapshot: runtimeSnapshot,
			startTime: 1000,
			success: false,
			testResults: [typecheckFile, runtimeFile],
		});
	});
});

describe(mergeProjectResults, () => {
	it("should reject an empty project result set", () => {
		expect.assertions(1);

		expect(() => mergeProjectResults([])).toThrow(
			"mergeProjectResults requires at least one result",
		);
	});

	it("should fail otherwise successful projects when snapshot writes failed", () => {
		expect.assertions(2);

		const merged = mergeProjectResults([
			makeExecuteResult(),
			makeExecuteResult({ snapshotWriteFailures: 2 }),
		]);

		expect(merged.exitCode).toBe(1);
		expect(merged.snapshotWriteFailures).toBe(2);
	});

	it("should omit a zero snapshot-write count from successful projects", () => {
		expect.assertions(2);

		const merged = mergeProjectResults([
			makeExecuteResult({ snapshotWriteFailures: 0 }),
			makeExecuteResult({ snapshotWriteFailures: 0 }),
		]);

		expect(merged.exitCode).toBe(0);
		expect(merged.snapshotWriteFailures).toBeUndefined();
	});

	it("should preserve every merged result and timing dimension", () => {
		expect.assertions(1);

		const snapshot = { added: 1, matched: 2, total: 4, unmatched: 1, updated: 0 };
		const first = makeExecuteResult({
			result: makeJestResult({
				numFailedTests: 1,
				numPassedTests: 2,
				numPendingTests: 3,
				numTodoTests: 4,
				numTotalTests: 10,
				snapshot,
				startTime: 3000,
				success: true,
			}),
			timing: {
				coverageMs: 11,
				executionMs: 22,
				setupMs: 5,
				startTime: 3000,
				testsMs: 33,
				totalMs: 44,
				uploadMs: 55,
			},
		});
		const second = makeExecuteResult({
			result: makeJestResult({
				numFailedTests: 5,
				numPassedTests: 6,
				numPendingTests: 7,
				numTodoTests: 8,
				numTotalTests: 26,
				startTime: 1000,
				success: false,
			}),
			snapshotWriteFailures: 2,
			timing: {
				coverageMs: 66,
				executionMs: 77,
				setupMs: 7,
				startTime: 1000,
				testsMs: 88,
				totalMs: 99,
				uploadMs: 111,
			},
		});

		expect(mergeProjectResults([first, second])).toStrictEqual({
			coverageData: undefined,
			exitCode: 1,
			output: "",
			result: {
				numFailedTests: 6,
				numPassedTests: 8,
				numPendingTests: 10,
				numTodoTests: 12,
				numTotalTests: 36,
				snapshot,
				startTime: 1000,
				success: false,
				testResults: [],
			},
			snapshotWriteFailures: 2,
			sourceMapper: undefined,
			timing: {
				coverageMs: 11,
				executionMs: 22,
				setupMs: 12,
				startTime: 1000,
				testsMs: 121,
				totalMs: 99,
				uploadMs: 55,
			},
		});
	});

	it("should keep the gaps of each named test across projects", () => {
		expect.assertions(1);

		const merged = mergeProjectResults([
			makeExecuteResult({ result: makeBlockedResult("src/client.spec.ts", "a") }),
			makeExecuteResult(),
			makeExecuteResult({ result: makeBlockedResult("src/server.spec.ts", "b") }),
		]);

		expect(
			merged.result.testResults.flatMap((file) => {
				return file.testResults.map((test) => {
					return [file.testFilePath, test.fullName, test.gaps];
				});
			}),
		).toStrictEqual([
			["src/client.spec.ts", "a", { script: 1 }],
			["src/server.spec.ts", "b", { script: 1 }],
		]);
	});

	it("should return the single result unchanged", () => {
		expect.assertions(1);

		const single = makeExecuteResult();

		expect(mergeProjectResults([single])).toBe(single);
	});

	it("should aggregate counts across multiple results", () => {
		expect.assertions(3);

		const a = makeExecuteResult({
			result: makeJestResult({
				numFailedTests: 1,
				numPassedTests: 2,
				numTotalTests: 3,
				success: false,
			}),
		});
		const b = makeExecuteResult({
			result: makeJestResult({
				numFailedTests: 0,
				numPassedTests: 4,
				numTotalTests: 4,
				success: true,
			}),
		});

		const merged = mergeProjectResults([a, b]);

		expect(merged.result.numFailedTests).toBe(1);
		expect(merged.result.numPassedTests).toBe(6);
		expect(merged.result.success).toBeFalse();
	});

	it("should merge coverage data across results", () => {
		expect.assertions(1);

		const a = makeExecuteResult({ coverageData: fromAny({ "a.luau": { s: { "0": 1 } } }) });
		const b = makeExecuteResult({ coverageData: fromAny({ "b.luau": { s: { "0": 1 } } }) });

		const merged = mergeProjectResults([a, b]);

		expect(merged.coverageData).toBeDefined();
	});

	it("should leave coverage undefined when no result has coverage", () => {
		expect.assertions(1);

		const a = makeExecuteResult();
		const b = makeExecuteResult();

		expect(mergeProjectResults([a, b]).coverageData).toBeUndefined();
	});

	it("should sum testsMs across results", () => {
		expect.assertions(1);

		const a = makeExecuteResult({
			timing: {
				executionMs: 100,
				startTime: 1000,
				testsMs: 50,
				totalMs: 200,
				uploadMs: 50,
			},
		});
		const b = makeExecuteResult({
			timing: {
				executionMs: 100,
				startTime: 2000,
				testsMs: 75,
				totalMs: 200,
				uploadMs: 50,
			},
		});

		expect(mergeProjectResults([a, b]).timing.testsMs).toBe(125);
	});

	it("should sum setupMs when present on any result", () => {
		expect.assertions(1);

		const a = makeExecuteResult({
			timing: {
				executionMs: 100,
				setupMs: 25,
				startTime: 1000,
				testsMs: 50,
				totalMs: 200,
				uploadMs: 50,
			},
		});
		const b = makeExecuteResult({
			timing: {
				executionMs: 100,
				setupMs: 35,
				startTime: 1000,
				testsMs: 50,
				totalMs: 200,
				uploadMs: 50,
			},
		});

		expect(mergeProjectResults([a, b]).timing.setupMs).toBe(60);
	});

	it("should leave setupMs undefined when no result has any setup time", () => {
		expect.assertions(1);

		expect(
			mergeProjectResults([makeExecuteResult(), makeExecuteResult()]).timing.setupMs,
		).toBeUndefined();
	});

	it("should combine source mappers across results", () => {
		expect.assertions(1);

		const sourceMapper = {
			mapFailureWithLocations: (message: string) => ({ locations: [], message }),
			mapTestFileLine: (): undefined => undefined,
			resolveDisplayPath: (testFilePath: string) => testFilePath,
			resolveTestFilePath: (): undefined => undefined,
		};
		const a = makeExecuteResult({ sourceMapper });
		const b = makeExecuteResult({ sourceMapper });

		expect(mergeProjectResults([a, b]).sourceMapper).toBeDefined();
	});

	it("should yield exitCode 0 when all results succeeded", () => {
		expect.assertions(1);

		expect(mergeProjectResults([makeExecuteResult(), makeExecuteResult()]).exitCode).toBe(0);
	});

	it("should yield exitCode 1 when any result failed", () => {
		expect.assertions(1);

		const failing = makeExecuteResult({
			result: makeJestResult({ success: false }),
		});

		expect(mergeProjectResults([makeExecuteResult(), failing]).exitCode).toBe(1);
	});

	it("should sum numTodoTests across results when present", () => {
		expect.assertions(1);

		const a = makeExecuteResult({
			result: makeJestResult({ numTodoTests: 2 }),
		});
		const b = makeExecuteResult({
			result: makeJestResult({ numTodoTests: 3 }),
		});

		expect(mergeProjectResults([a, b]).result.numTodoTests).toBe(5);
	});

	it("should default numTodoTests to 0 when undefined on results", () => {
		expect.assertions(1);

		const a = makeExecuteResult({
			result: { ...makeJestResult(), numTodoTests: undefined },
		});
		const b = makeExecuteResult({
			result: { ...makeJestResult(), numTodoTests: undefined },
		});

		expect(mergeProjectResults([a, b]).result.numTodoTests).toBe(0);
	});

	it("should fold every project's snapshot summary into the merged one", () => {
		expect.assertions(1);

		const first = { added: 1, matched: 2, total: 3, unmatched: 0, updated: 0 };
		const second = { added: 0, matched: 4, total: 5, unmatched: 1, updated: 0 };
		const a = makeExecuteResult({ result: { ...makeJestResult(), snapshot: first } });
		const b = makeExecuteResult({ result: { ...makeJestResult(), snapshot: second } });

		expect(mergeProjectResults([a, b]).result.snapshot).toStrictEqual({
			added: 1,
			matched: 6,
			total: 8,
			unmatched: 1,
			updated: 0,
		});
	});
});
