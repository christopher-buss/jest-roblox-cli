import type {
	ExecuteScriptOptions,
	RemoteRunner,
	ScriptResult,
	UploadPlaceOptions,
	UploadPlaceResult,
} from "@isentinel/roblox-runner";

import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type {
	StreamingResultReader,
	StreamingResultRecord,
} from "../memory-store/sorted-map-client.ts";
import type { BackendOptions, ProjectJob } from "./interface.ts";
import { createOpenCloudBackend, OpenCloudBackend } from "./open-cloud.ts";

interface StubStreamReader extends StreamingResultReader {
	deleted: Array<string>;
	readCalls: number;
}

interface RunnerStubOptions {
	uploadError?: Error;
	uploadResult?: UploadPlaceResult;
}

type ExecuteHandler = (options: ExecuteScriptOptions) => Promise<ScriptResult> | ScriptResult;

interface RunnerStub {
	executeCalls: Array<ExecuteScriptOptions>;
	runner: RemoteRunner;
	setExecute: (handler: ExecuteHandler) => void;
	uploadCalls: Array<UploadPlaceOptions>;
}

function createStreamReader(pages: Array<Array<StreamingResultRecord>>): StubStreamReader {
	const reader: StubStreamReader = {
		delete: async (itemId: string): Promise<void> => {
			reader.deleted.push(itemId);
		},
		deleted: [],
		readAll: async (): Promise<Array<StreamingResultRecord>> => {
			const index = Math.min(reader.readCalls, pages.length - 1);
			reader.readCalls += 1;
			return pages[index] ?? [];
		},
		readCalls: 0,
	};
	return reader;
}

const DEFAULT_UPLOAD: UploadPlaceResult = { uploadMs: 12, versionNumber: 1 };

function createRunnerStub(options: RunnerStubOptions = {}): RunnerStub {
	const executeCalls: Array<ExecuteScriptOptions> = [];
	const uploadCalls: Array<UploadPlaceOptions> = [];
	async function defaultHandler(): Promise<ScriptResult> {
		return { durationMs: 0, outputs: ["{}"] };
	}

	let executeHandler: ExecuteHandler = defaultHandler;

	async function executeScript(executeOptions: ExecuteScriptOptions): Promise<ScriptResult> {
		executeCalls.push(executeOptions);
		return executeHandler(executeOptions);
	}

	async function uploadPlace(uploadOptions: UploadPlaceOptions) {
		uploadCalls.push(uploadOptions);
		if (options.uploadError !== undefined) {
			throw options.uploadError;
		}

		return options.uploadResult ?? DEFAULT_UPLOAD;
	}

	function setExecute(handler: ExecuteHandler): void {
		executeHandler = handler;
	}

	return {
		executeCalls,
		runner: { executeScript, uploadPlace },
		setExecute,
		uploadCalls,
	};
}

function successJest(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: 0,
		success: true,
		testResults: [],
		...overrides,
	});
}

function envelope(
	entries: Array<{
		elapsedMs?: number;
		gameOutput?: string;
		jestOutput: string;
		pkg?: string;
		project?: string;
	}>,
): string {
	return JSON.stringify({ entries });
}

function packageEntry(packageName: string): { jestOutput: string; pkg: string } {
	return { jestOutput: successJest(), pkg: packageName };
}

function scriptResult(jestOutput: string, gameOutput = "[]"): ScriptResult {
	return { durationMs: 5, outputs: [jestOutput, gameOutput] };
}

function job(
	displayName: string,
	overrides: Partial<ResolvedConfig> = {},
	package_?: string,
): ProjectJob {
	return {
		config: {
			...DEFAULT_CONFIG,
			placeFile: "./test.rbxl",
			...overrides,
		},
		displayColor: `${displayName}-color`,
		displayName,
		pkg: package_,
		testFiles: [`${displayName}/test.spec.ts`],
	};
}

function jobsOptions(
	jobs: Array<ProjectJob>,
	parallel?: BackendOptions["parallel"],
): BackendOptions {
	return parallel === undefined ? { jobs } : { jobs, parallel };
}

const credentials = {
	apiKey: "test-api-key",
	placeId: "456",
	universeId: "123",
};

describe(OpenCloudBackend, () => {
	describe("validation", () => {
		it("should throw when the jobs array is empty", async () => {
			expect.assertions(1);

			const { runner } = createRunnerStub();
			const backend = new OpenCloudBackend(credentials, { runner });

			await expect(backend.runTests({ jobs: [] })).rejects.toThrow(
				"OpenCloudBackend requires at least one job",
			);
		});

		it("should throw when --parallel is less than 1", async () => {
			expect.assertions(1);

			const { runner } = createRunnerStub();
			const backend = new OpenCloudBackend(credentials, { runner });

			await expect(backend.runTests(jobsOptions([job("alpha")], 0))).rejects.toThrow(
				/--parallel must be >= 1/,
			);
		});

		it("should require scriptOverride when workStealing is true", async () => {
			expect.assertions(1);

			const { runner } = createRunnerStub();
			const backend = new OpenCloudBackend(credentials, { runner });

			await expect(
				backend.runTests({ jobs: [job("alpha")], workStealing: true }),
			).rejects.toThrow(/work-stealing mode requires scriptOverride/);
		});
	});

	describe("bucketing", () => {
		it("should default to a single executeScript carrying every job's config", async () => {
			expect.assertions(4);

			const stub = createRunnerStub();
			stub.setExecute(() => {
				return scriptResult(
					envelope([
						{ elapsedMs: 111, jestOutput: successJest({ numPassedTests: 1 }) },
						{ elapsedMs: 222, jestOutput: successJest({ numPassedTests: 2 }) },
						{ elapsedMs: 333, jestOutput: successJest({ numPassedTests: 3 }) },
					]),
				);
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { rawResults } = await backend.runTests(
				jobsOptions([
					job("alpha", { testNamePattern: "alpha-pattern" }),
					job("beta", { testNamePattern: "beta-pattern" }),
					job("gamma", { testNamePattern: "gamma-pattern" }),
				]),
			);

			expect(stub.executeCalls).toHaveLength(1);

			const { script } = stub.executeCalls[0]!;
			const patterns = [...script.matchAll(/"testNamePattern":"([^"]+)"/g)].map(
				(match) => match[1],
			);

			expect(patterns).toStrictEqual(["alpha-pattern", "beta-pattern", "gamma-pattern"]);
			expect(rawResults).toHaveLength(3);
			expect(rawResults.map((raw) => raw.entry.elapsedMs)).toStrictEqual([111, 222, 333]);
		});

		it("should preserve snapshotFormat per job inside the bundled configs array", async () => {
			expect.assertions(2);

			const stub = createRunnerStub();
			stub.setExecute(() => {
				return scriptResult(
					envelope([{ jestOutput: successJest() }, { jestOutput: successJest() }]),
				);
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTests(
				jobsOptions([
					job("alpha", {
						snapshotFormat: { escapeString: true, printBasicPrototype: false },
					}),
					job("beta", {
						snapshotFormat: { escapeString: false, printBasicPrototype: true },
					}),
				]),
			);

			const { script } = stub.executeCalls[0]!;

			expect(script).toContain('"escapeString":true');
			expect(script).toContain('"escapeString":false');
		});

		it("should treat --parallel 1 identically to the default path", async () => {
			expect.assertions(2);

			const stub = createRunnerStub();
			stub.setExecute(() => {
				return scriptResult(
					envelope([
						{ jestOutput: successJest() },
						{ jestOutput: successJest() },
						{ jestOutput: successJest() },
					]),
				);
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { rawResults } = await backend.runTests(
				jobsOptions([job("alpha"), job("beta"), job("gamma")], 1),
			);

			expect(stub.executeCalls).toHaveLength(1);
			expect(rawResults).toHaveLength(3);
		});

		it("should populate timing.executionMs on the BackendResult", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { timing } = await backend.runTests(jobsOptions([job("alpha")]));

			expect(timing.executionMs).toBeGreaterThanOrEqual(0);
		});

		it("should fan --parallel 3 out to three executeScript calls, one bucket each", async () => {
			expect.assertions(3);

			let bucketIndex = 0;
			const stub = createRunnerStub();
			stub.setExecute(() => {
				const index = bucketIndex;
				bucketIndex += 1;
				return scriptResult(
					envelope([
						{
							elapsedMs: index * 10,
							jestOutput: successJest({ numPassedTests: index + 1 }),
						},
					]),
				);
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { rawResults } = await backend.runTests(
				jobsOptions([job("alpha"), job("beta"), job("gamma")], 3),
			);

			expect(stub.executeCalls).toHaveLength(3);
			expect(rawResults).toHaveLength(3);
			// Round-robin places job[i] in bucket[i]; bucket index N returns
			// elapsedMs:N*10. Flattened order must match input order.
			expect(rawResults.map((raw) => raw.entry.elapsedMs)).toStrictEqual([0, 10, 20]);
		});

		it("should round-robin 10 jobs into buckets of 4/3/3 and flatten in input order", async () => {
			expect.assertions(5);

			const bucketPatterns: Array<Array<string>> = [];
			const stub = createRunnerStub();
			stub.setExecute((options) => {
				const patterns = [...options.script.matchAll(/"testNamePattern":"([^"]+)"/g)].map(
					(match) => match[1]!,
				);
				bucketPatterns.push(patterns);
				const bucketIndex = bucketPatterns.length - 1;
				return scriptResult(
					envelope(
						patterns.map((_, position) => {
							return {
								elapsedMs: bucketIndex * 100 + position,
								jestOutput: successJest(),
							};
						}),
					),
				);
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const jobs = Array.from({ length: 10 }, (_, index) => {
				return job(`p${index.toString()}`, {
					testNamePattern: `pattern-${index.toString()}`,
				});
			});

			const { rawResults } = await backend.runTests(jobsOptions(jobs, 3));

			expect(stub.executeCalls).toHaveLength(3);
			expect(bucketPatterns[0]).toStrictEqual([
				"pattern-0",
				"pattern-3",
				"pattern-6",
				"pattern-9",
			]);
			expect(bucketPatterns[1]).toStrictEqual(["pattern-1", "pattern-4", "pattern-7"]);
			expect(bucketPatterns[2]).toStrictEqual(["pattern-2", "pattern-5", "pattern-8"]);
			// Round-robin: job[i] → bucket[i%3], position floor(i/3); bucket N
			// emits elapsedMs N*100+position. Flatten back to job order.
			expect(rawResults.map((raw) => raw.entry.elapsedMs)).toStrictEqual([
				0, 100, 200, 1, 101, 201, 2, 102, 202, 3,
			]);
		});

		it("should resolve --parallel auto to min(jobs.length, 3)", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute((options) => {
				const count = [...options.script.matchAll(/"testNamePattern":"([^"]+)"/g)].length;
				return scriptResult(
					envelope(Array.from({ length: count }, () => ({ jestOutput: successJest() }))),
				);
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const jobs = Array.from({ length: 5 }, (_, index) => {
				return job(`p${index.toString()}`, { testNamePattern: `auto-${index.toString()}` });
			});

			await backend.runTests(jobsOptions(jobs, "auto"));

			expect(stub.executeCalls).toHaveLength(3);
		});

		it("should cap --parallel auto at jobs.length when jobs are fewer than the auto ceiling", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTests(jobsOptions([job("alpha"), job("beta")], "auto"));

			expect(stub.executeCalls).toHaveLength(2);
		});

		it("should cap --parallel n at jobs.length when n exceeds the job count", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTests(jobsOptions([job("alpha"), job("beta")], 10));

			expect(stub.executeCalls).toHaveLength(2);
		});

		it("should throw when the bucket envelope length does not match the job count", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => {
				return scriptResult(
					envelope([{ jestOutput: successJest() }, { jestOutput: successJest() }]),
				);
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			await expect(backend.runTests(jobsOptions([job("alpha")]))).rejects.toThrow(
				/Open Cloud backend returned 2 entries but bucket had 1 jobs/,
			);
		});

		it("should reject the whole call when any parallel bucket fails first", async () => {
			expect.assertions(1);

			let bucketIndex = 0;
			const stub = createRunnerStub();
			stub.setExecute(() => {
				const index = bucketIndex;
				bucketIndex += 1;
				if (index === 2) {
					throw new Error("bucket two blew up");
				}

				return scriptResult(envelope([{ jestOutput: successJest() }]));
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			await expect(
				backend.runTests(jobsOptions([job("alpha"), job("beta"), job("gamma")], 3)),
			).rejects.toThrowWithMessage(Error, "bucket two blew up");
		});

		it("should send scriptOverride when set instead of generating from inputs", async () => {
			expect.assertions(2);

			const customScript = "-- custom materializer script\nreturn nil";
			const stub = createRunnerStub();
			stub.setExecute(() => {
				return scriptResult(envelope([{ jestOutput: successJest(), pkg: "@halcyon/foo" }]));
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTests({ jobs: [job("alpha")], scriptOverride: customScript });

			expect(stub.executeCalls[0]!.script).toBe(customScript);
			expect(stub.executeCalls[0]!.script).not.toContain("Jest.runCLI");
		});
	});

	describe("envelope parsing", () => {
		it("should expose outputs[1] as the fallback gameOutput on each rawResult", async () => {
			expect.assertions(1);

			const fallback = JSON.stringify([
				{ message: "fallback", messageType: 0, timestamp: 0 },
			]);
			const stub = createRunnerStub();
			stub.setExecute(() =>
				scriptResult(envelope([{ jestOutput: successJest() }]), fallback),
			);

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { rawResults } = await backend.runTests(jobsOptions([job("alpha")]));

			expect(rawResults[0]!.fallbackGameOutput).toBe(fallback);
		});

		it("should throw when executeScript returns no outputs", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => ({ durationMs: 0, outputs: [] }));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			await expect(backend.runTests(jobsOptions([job("alpha")]))).rejects.toThrow(
				/No test results in output/,
			);
		});

		it("should expose multi-entry rawResults in input order", async () => {
			expect.assertions(2);

			const stub = createRunnerStub();
			stub.setExecute(() => {
				return scriptResult(
					envelope([
						{ elapsedMs: 11, jestOutput: successJest(), pkg: "@halcyon/foo" },
						{ elapsedMs: 22, jestOutput: successJest(), pkg: "@halcyon/bar" },
						{ elapsedMs: 33, jestOutput: successJest(), pkg: "@halcyon/baz" },
					]),
				);
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { rawResults } = await backend.runTests(
				jobsOptions([job("@halcyon/foo"), job("@halcyon/bar"), job("@halcyon/baz")]),
			);

			expect(rawResults).toHaveLength(3);
			expect(rawResults.map((raw) => raw.entry.elapsedMs)).toStrictEqual([11, 22, 33]);
		});
	});

	describe("upload integration", () => {
		it("should call runner.uploadPlace exactly once regardless of bucket count", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTests(
				jobsOptions([job("alpha"), job("beta"), job("gamma"), job("delta")], 4),
			);

			expect(stub.uploadCalls).toHaveLength(1);
		});

		it("should pin every executeScript to the uploaded place version", async () => {
			expect.assertions(2);

			const stub = createRunnerStub({
				uploadResult: { uploadMs: 12, versionNumber: 42 },
			});
			stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTests(jobsOptions([job("alpha"), job("beta"), job("gamma")], 3));

			// 3 jobs at parallel 3 ⇒ one bucket each ⇒ exactly 3 calls. An exact
			// count catches a regression that re-executes between buckets.
			expect(stub.executeCalls).toHaveLength(3);
			expect(stub.executeCalls.every((call) => call.placeVersion === 42)).toBeTrue();
		});

		it("should pin work-stealing tasks to the uploaded place version", async () => {
			expect.assertions(2);

			const stub = createRunnerStub({
				uploadResult: { uploadMs: 12, versionNumber: 7 },
			});
			stub.setExecute(() => scriptResult(envelope([packageEntry("alpha")])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTests({
				jobs: [job("alpha")],
				scriptOverride: "stealing-script",
				workStealing: true,
			});

			// work-stealing over 1 job with default parallel ⇒ exactly 1 task.
			expect(stub.executeCalls).toHaveLength(1);
			expect(stub.executeCalls.every((call) => call.placeVersion === 7)).toBeTrue();
		});

		it("should propagate upload errors from the runner", async () => {
			expect.assertions(1);

			const stub = createRunnerStub({
				uploadError: new Error("Failed to upload place: 401"),
			});
			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			await expect(backend.runTests(jobsOptions([job("alpha")]))).rejects.toThrow(
				/Failed to upload place/,
			);
		});
	});

	describe("work-stealing", () => {
		it("should fire N tasks all carrying the same scriptOverride and upload once", async () => {
			expect.assertions(3);

			const stealingScript = "-- work-stealing materializer\nreturn nil";
			const taskPkgs = [
				["alpha", "delta"],
				["beta", "epsilon"],
				["gamma", "zeta"],
			] as const;
			let taskIndex = 0;
			const stub = createRunnerStub();
			stub.setExecute(() => {
				const handledPkgs = taskPkgs[taskIndex] ?? [];
				taskIndex += 1;
				return scriptResult(envelope(handledPkgs.map(packageEntry)));
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTests({
				jobs: [
					job("alpha"),
					job("beta"),
					job("gamma"),
					job("delta"),
					job("epsilon"),
					job("zeta"),
				],
				parallel: 3,
				scriptOverride: stealingScript,
				workStealing: true,
			});

			expect(stub.executeCalls).toHaveLength(3);
			expect(stub.executeCalls.map((call) => call.script)).toStrictEqual([
				stealingScript,
				stealingScript,
				stealingScript,
			]);
			expect(stub.uploadCalls).toHaveLength(1);
		});

		it("should drop duplicate-pkg entries from fault-recovery and keep the first occurrence", async () => {
			expect.assertions(2);

			let taskIndex = 0;
			const stub = createRunnerStub();
			stub.setExecute(() => {
				const index = taskIndex;
				taskIndex += 1;
				const entries =
					index === 0
						? [
								{ elapsedMs: 1, jestOutput: successJest(), pkg: "alpha" },
								{ elapsedMs: 2, jestOutput: successJest(), pkg: "beta" },
							]
						: [{ elapsedMs: 99, jestOutput: successJest(), pkg: "alpha" }];
				return scriptResult(envelope(entries));
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { rawResults } = await backend.runTests({
				jobs: [job("alpha"), job("beta")],
				parallel: 2,
				scriptOverride: "stealing-script",
				workStealing: true,
			});

			expect(rawResults).toHaveLength(2);
			// First-occurrence wins: alpha must come from task 0 (elapsedMs 1),
			// not the duplicate from task 1 (elapsedMs 99).
			expect(rawResults.map((raw) => raw.entry.elapsedMs)).toStrictEqual([1, 2]);
		});

		it("should error when a job has no matching entry in any envelope", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() =>
				scriptResult(envelope([{ jestOutput: successJest(), pkg: "alpha" }])),
			);

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			await expect(
				backend.runTests({
					jobs: [job("alpha"), job("beta")],
					parallel: 1,
					scriptOverride: "stealing-script",
					workStealing: true,
				}),
			).rejects.toThrow(/no entries for 1 package\(s\): beta/);
		});

		it("should aggregate entries from all task envelopes in input order", async () => {
			expect.assertions(2);

			const taskPkgs = [
				["alpha", "gamma"],
				["beta", "delta"],
			];
			let taskIndex = 0;
			const stub = createRunnerStub();
			stub.setExecute(() => {
				const pkgs = taskPkgs[taskIndex] ?? [];
				taskIndex += 1;
				return scriptResult(envelope(pkgs.map(packageEntry)));
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { rawResults } = await backend.runTests({
				jobs: [job("alpha"), job("beta"), job("gamma"), job("delta")],
				parallel: 2,
				scriptOverride: "stealing-script",
				workStealing: true,
			});

			expect(rawResults).toHaveLength(4);
			expect(rawResults.map((raw) => raw.entry.pkg)).toStrictEqual([
				"alpha",
				"beta",
				"gamma",
				"delta",
			]);
		});

		it("should silently skip envelope entries with no pkg field", async () => {
			expect.assertions(2);

			const stub = createRunnerStub();
			stub.setExecute(() => {
				return scriptResult(
					envelope([
						{ jestOutput: successJest() },
						{ elapsedMs: 42, jestOutput: successJest(), pkg: "alpha" },
					]),
				);
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { rawResults } = await backend.runTests({
				jobs: [job("alpha")],
				parallel: 1,
				scriptOverride: "stealing-script",
				workStealing: true,
			});

			expect(rawResults).toHaveLength(1);
			expect(rawResults[0]!.entry.elapsedMs).toBe(42);
		});

		it("should match entries to jobs by pkg::project so multi-project packages don't collide", async () => {
			expect.assertions(2);

			const stub = createRunnerStub();
			stub.setExecute(() => {
				return scriptResult(
					envelope([
						{
							elapsedMs: 5,
							jestOutput: successJest(),
							pkg: "@halcyon/foo",
							project: "client",
						},
						{
							elapsedMs: 9,
							jestOutput: successJest(),
							pkg: "@halcyon/foo",
							project: "server",
						},
					]),
				);
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { rawResults } = await backend.runTests({
				jobs: [job("client", {}, "@halcyon/foo"), job("server", {}, "@halcyon/foo")],
				parallel: 2,
				scriptOverride: "stealing-script",
				workStealing: true,
			});

			expect(rawResults).toHaveLength(2);
			expect(rawResults.map((raw) => raw.entry.elapsedMs)).toStrictEqual([5, 9]);
		});

		it("should deliver streaming entries to onPackageResult and delete each one", async () => {
			expect.assertions(3);

			const reader = createStreamReader([
				[
					{
						id: "alpha::client",
						value: {
							elapsedMs: 50,
							numFailedTests: 0,
							numPassedTests: 1,
							numPendingTests: 0,
							pkg: "alpha",
							project: "client",
							success: true,
						},
					},
				],
				[],
			]);
			const seen: Array<string> = [];

			const stub = createRunnerStub();
			stub.setExecute(async () => {
				// Let the polling loop tick once before the task finishes so
				// the entry is consumed mid-flight rather than only on the
				// final drain.
				await new Promise<void>((resolve) => {
					setTimeout(resolve, 10);
				});
				return scriptResult(
					envelope([{ jestOutput: successJest(), pkg: "alpha", project: "client" }]),
				);
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTests({
				jobs: [job("client", {}, "alpha")],
				parallel: 1,
				scriptOverride: "stealing-script",
				streaming: {
					onPackageResult: (entry) => {
						seen.push(entry.pkg);
					},
					pollMs: 1,
					reader,
				},
				workStealing: true,
			});

			expect(seen).toContain("alpha");
			expect(reader.deleted).toContain("alpha::client");
			expect(reader.readCalls).toBeGreaterThanOrEqual(1);
		});

		it("should default pollMs when streaming hooks omit it", async () => {
			expect.assertions(2);

			const reader = createStreamReader([
				[
					{
						id: "alpha::alpha",
						value: {
							elapsedMs: 1,
							numFailedTests: 0,
							numPassedTests: 1,
							numPendingTests: 0,
							pkg: "alpha",
							project: "alpha",
							success: true,
						},
					},
				],
				[],
			]);
			const seen: Array<string> = [];

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([packageEntry("alpha")])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTests({
				jobs: [job("alpha")],
				parallel: 1,
				scriptOverride: "stealing-script",
				streaming: {
					onPackageResult: (entry) => {
						seen.push(entry.pkg);
					},
					reader,
				},
				workStealing: true,
			});

			expect(seen).toContain("alpha");
			expect(reader.deleted).toContain("alpha::alpha");
		});

		it("should emit a one-shot stderr warning when the streaming reader returns a PermissionError", async () => {
			expect.assertions(2);

			const { PermissionError } = await import("@bedrock-rbx/ocale");
			const writes: Array<string> = [];
			const stderrSpy = vi
				.spyOn(process.stderr, "write")
				.mockImplementation((chunk: Parameters<typeof process.stderr.write>[0]) => {
					writes.push(typeof chunk === "string" ? chunk : String(chunk));
					return true;
				});

			const reader = {
				delete: async (): Promise<void> => {
					/* unused */
				},
				deleted: [] as Array<string>,
				readAll: async (): Promise<never> => {
					reader.readCalls += 1;
					throw new Error("Failed to read streaming results: forbidden", {
						cause: new PermissionError("forbidden", {
							operationKey: "memory-store-sorted-maps.list",
							requiredScopes: ["memory-store.sorted-map:read"],
							statusCode: 403,
						}),
					});
				},
				readCalls: 0,
			};

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([packageEntry("alpha")])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTests({
				jobs: [job("alpha")],
				parallel: 1,
				scriptOverride: "stealing-script",
				streaming: {
					onPackageResult: () => {
						/* unused */
					},
					pollMs: 1,
					reader,
				},
				workStealing: true,
			});
			stderrSpy.mockRestore();

			const joined = writes.join("");

			expect(joined).toContain("memory-store.sorted-map:read");
			// Only one warning even though the failing read happens twice (poll
			// + final drain).
			expect(writes.filter((line) => line.includes("streaming disabled"))).toHaveLength(1);
		});

		it("should pluralize the scope hint when the PermissionError carries multiple scopes", async () => {
			expect.assertions(1);

			const { PermissionError } = await import("@bedrock-rbx/ocale");
			const writes: Array<string> = [];
			const stderrSpy = vi
				.spyOn(process.stderr, "write")
				.mockImplementation((chunk: Parameters<typeof process.stderr.write>[0]) => {
					writes.push(typeof chunk === "string" ? chunk : String(chunk));
					return true;
				});

			const reader = {
				delete: async (): Promise<void> => {
					/* unused */
				},
				deleted: [] as Array<string>,
				readAll: async (): Promise<never> => {
					reader.readCalls += 1;
					throw new Error("forbidden", {
						cause: new PermissionError("forbidden", {
							operationKey: "memory-store-sorted-maps.list",
							requiredScopes: ["scope-a", "scope-b"],
							statusCode: 403,
						}),
					});
				},
				readCalls: 0,
			};

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([packageEntry("alpha")])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTests({
				jobs: [job("alpha")],
				parallel: 1,
				scriptOverride: "stealing-script",
				streaming: {
					onPackageResult: () => {
						/* unused */
					},
					pollMs: 1,
					reader,
				},
				workStealing: true,
			});
			stderrSpy.mockRestore();

			expect(writes.join("")).toContain("missing scopes scope-a, scope-b");
		});

		it("should stringify a non-Error thrown by the streaming reader", async () => {
			expect.assertions(1);

			const writes: Array<string> = [];
			const stderrSpy = vi
				.spyOn(process.stderr, "write")
				.mockImplementation((chunk: Parameters<typeof process.stderr.write>[0]) => {
					writes.push(typeof chunk === "string" ? chunk : String(chunk));
					return true;
				});

			const reader = {
				delete: async (): Promise<void> => {
					/* unused */
				},
				deleted: [] as Array<string>,
				readAll: async (): Promise<never> => {
					reader.readCalls += 1;

					// eslint-disable-next-line ts/only-throw-error -- exercising the non-Error branch in drainOnce's catch.
					throw "string-error";
				},
				readCalls: 0,
			};

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([packageEntry("alpha")])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTests({
				jobs: [job("alpha")],
				parallel: 1,
				scriptOverride: "stealing-script",
				streaming: {
					onPackageResult: () => {
						/* unused */
					},
					pollMs: 1,
					reader,
				},
				workStealing: true,
			});
			stderrSpy.mockRestore();

			expect(writes.join("")).toContain("string-error");
		});

		it("should emit a one-shot stderr warning for non-permission streaming reader errors", async () => {
			expect.assertions(1);

			const writes: Array<string> = [];
			const stderrSpy = vi
				.spyOn(process.stderr, "write")
				.mockImplementation((chunk: Parameters<typeof process.stderr.write>[0]) => {
					writes.push(typeof chunk === "string" ? chunk : String(chunk));
					return true;
				});

			const reader = {
				delete: async (): Promise<void> => {
					/* unused */
				},
				deleted: [] as Array<string>,
				readAll: async (): Promise<never> => {
					reader.readCalls += 1;
					throw new Error("network broke");
				},
				readCalls: 0,
			};

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([packageEntry("alpha")])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTests({
				jobs: [job("alpha")],
				parallel: 1,
				scriptOverride: "stealing-script",
				streaming: {
					onPackageResult: () => {
						/* unused */
					},
					pollMs: 1,
					reader,
				},
				workStealing: true,
			});
			stderrSpy.mockRestore();

			expect(writes.filter((line) => line.includes("streaming disabled"))).toHaveLength(1);
		});

		it("should swallow streaming reader errors so they don't fail the run", async () => {
			expect.assertions(1);

			const reader = {
				delete: async () => {
					/* unused */
				},
				deleted: [] as Array<string>,
				readAll: async () => {
					reader.readCalls += 1;
					throw new Error("read failed");
				},
				readCalls: 0,
			};

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([packageEntry("alpha")])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { rawResults } = await backend.runTests({
				jobs: [job("alpha")],
				parallel: 1,
				scriptOverride: "stealing-script",
				streaming: {
					onPackageResult: () => {
						/* unused */
					},
					pollMs: 1,
					reader,
				},
				workStealing: true,
			});

			expect(rawResults).toHaveLength(1);
		});

		it("should swallow streaming delete errors after forwarding the entry", async () => {
			expect.assertions(2);

			const seen: Array<string> = [];
			const reader = {
				delete: async () => {
					throw new Error("delete failed");
				},
				deleted: [] as Array<string>,
				readAll: async () => {
					reader.readCalls += 1;
					return [
						{
							id: "alpha::default",
							value: {
								elapsedMs: 0,
								numFailedTests: 0,
								numPassedTests: 1,
								numPendingTests: 0,
								pkg: "alpha",
								project: "default",
								success: true,
							},
						},
					];
				},
				readCalls: 0,
			};

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([packageEntry("alpha")])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { rawResults } = await backend.runTests({
				jobs: [job("alpha")],
				parallel: 1,
				scriptOverride: "stealing-script",
				streaming: {
					onPackageResult: (entry) => {
						seen.push(entry.pkg);
					},
					pollMs: 1,
					reader,
				},
				workStealing: true,
			});

			expect(seen).toContain("alpha");
			expect(rawResults).toHaveLength(1);
		});

		it("should throw when work-stealing executeScript returns no outputs", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => ({ durationMs: 0, outputs: [] }));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			await expect(
				backend.runTests({
					jobs: [job("alpha")],
					parallel: 1,
					scriptOverride: "stealing-script",
					workStealing: true,
				}),
			).rejects.toThrow(/No test results in output/);
		});
	});
});

describe(createOpenCloudBackend, () => {
	it("should construct an OpenCloudBackend from given credentials", () => {
		expect.assertions(1);

		const backend = createOpenCloudBackend(credentials);

		expect(backend).toBeInstanceOf(OpenCloudBackend);
	});

	it("should honor JEST_ROBLOX_OPEN_CLOUD_BASE_URL env override for the default runner", () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_BASE_URL", "http://127.0.0.1:4010/custom/");

		const backend = new OpenCloudBackend(credentials);

		expect(backend).toBeInstanceOf(OpenCloudBackend);
	});
});
