import { PollTimeoutError } from "@bedrock-rbx/ocale";
import type {
	ExecuteScriptOptions,
	RemoteRunner,
	ScriptResult,
	UploadPlaceOptions,
	UploadPlaceResult,
} from "@isentinel/roblox-runner";
import { formatPlaceMismatch, PLACE_MISMATCH } from "@isentinel/roblox-runner/testing";

import * as path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { NOOP_PROGRESS } from "#test/mocks/noop-progress.ts";
import { projectJob } from "#test/mocks/project-job.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import {
	captureStderr,
	envelope,
	packageJobIndex,
	scriptResult,
} from "#test/mocks/spec-open-cloud.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { ConfiguredJob } from "../executor/executor-types.ts";
import type { prepareWorkStealingQueueAsync } from "../memory-store/work-stealing.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import type { ParallelOption } from "./interface.ts";
import type { OpenCloudDispatch } from "./open-cloud-dispatch.ts";
import { OpenCloudBackend } from "./open-cloud.ts";
import type { OpenCloudOptions } from "./open-cloud.ts";

interface RunnerStubOptions {
	uploadError?: Error;
	uploadResult?: UploadPlaceResult;
}

type ExecuteHandler = (options: ExecuteScriptOptions) => Promise<ScriptResult> | ScriptResult;

type ExecuteStep = () => Promise<ScriptResult> | ScriptResult;

interface RunnerStub {
	executeCalls: Array<ExecuteScriptOptions>;
	/** Boot-probe submits, kept apart so a test counts only its own tasks. */
	probeCalls: Array<ExecuteScriptOptions>;
	runner: RemoteRunner;
	setExecute: (handler: ExecuteHandler) => void;
	setProbe: (handler: ExecuteHandler) => void;
	uploadCalls: Array<UploadPlaceOptions>;
}

function stubQueue(): ReturnType<typeof vi.fn<typeof prepareWorkStealingQueueAsync>> {
	return vi.fn<typeof prepareWorkStealingQueueAsync>(async () => {
		return { invisibilityWindowSeconds: 90, queueId: "queue-1", ttlSeconds: 600 };
	});
}

function createBackend(options: OpenCloudOptions): OpenCloudBackend {
	return new OpenCloudBackend(credentials, {
		prepareWorkStealingQueue: stubQueue(),
		...options,
	});
}

const DEFAULT_UPLOAD: UploadPlaceResult = { uploadMs: 12, versionNumber: 1 };

function createRunnerStub(options: RunnerStubOptions = {}): RunnerStub {
	const executeCalls: Array<ExecuteScriptOptions> = [];
	const probeCalls: Array<ExecuteScriptOptions> = [];
	const uploadCalls: Array<UploadPlaceOptions> = [];
	async function defaultHandlerAsync(): Promise<ScriptResult> {
		return { durationMs: 0, outputs: ["{}"] };
	}

	async function defaultProbeAsync(): Promise<ScriptResult> {
		const uploaded = (options.uploadResult ?? DEFAULT_UPLOAD).versionNumber;
		return { durationMs: 0, outputs: [String(uploaded)] };
	}

	let executeHandler: ExecuteHandler = defaultHandlerAsync;
	let probeHandler: ExecuteHandler = defaultProbeAsync;

	/**
	 * The probe is infrastructure, not one of the run's tasks: routing it to
	 * its own list and its own handler keeps every other test written as
	 * though it did not exist.
	 * @param executeOptions - Options of the submitted task.
	 * @returns Result from the probe or the execute handler.
	 */
	async function executeScriptAsync(executeOptions: ExecuteScriptOptions): Promise<ScriptResult> {
		if (executeOptions.script === "return tostring(game.PlaceVersion)") {
			probeCalls.push(executeOptions);
			return probeHandler(executeOptions);
		}

		executeCalls.push(executeOptions);
		return executeHandler(executeOptions);
	}

	async function uploadPlaceAsync(uploadOptions: UploadPlaceOptions) {
		uploadCalls.push(uploadOptions);
		if (options.uploadError !== undefined) {
			throw options.uploadError;
		}

		return options.uploadResult ?? DEFAULT_UPLOAD;
	}

	function setExecute(handler: ExecuteHandler): void {
		executeHandler = handler;
	}

	function setProbe(handler: ExecuteHandler): void {
		probeHandler = handler;
	}

	return {
		executeCalls,
		probeCalls,
		runner: { executeScriptAsync, uploadPlaceAsync },
		setExecute,
		setProbe,
		uploadCalls,
	};
}

function successJest(overrides: Partial<JestResult> = {}): string {
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

function scriptJobIndices(script: string): Array<number> {
	return Array.from(script.matchAll(/"runnerJobIndex":(\d+)/g), (match) => Number(match[1]));
}

function packageEntry(packageName: string) {
	return { jestOutput: successJest(), jobIndex: packageJobIndex(packageName), pkg: packageName };
}

/**
 * The packages a materializer script carries, read back off the
 * submitted task.
 * @param options - Options of the submitted task.
 * @returns Package names in the script.
 */
function requestedNames(options: ExecuteScriptOptions): Array<string> {
	return Array.from(options.script.matchAll(/"pkg":"([^"]+)"/g), (match) => match[1]!);
}

/**
 * An envelope answering exactly the packages a script asked for.
 * @param options - Options of the submitted task.
 * @returns Passing result for each requested package.
 */
function scriptedEntries(options: ExecuteScriptOptions): ScriptResult {
	return scriptResult(envelope(requestedNames(options).map(packageEntry)));
}

/**
 * An execute handler that runs `steps[callIndex]`, repeating the final step
 * once the list is exhausted. Keeps per-call-index dispatch out of `it`
 * bodies.
 * @param steps - Handlers by call index.
 * @returns Execute handler.
 */
function stepExecute(steps: Array<ExecuteStep>): ExecuteHandler {
	let callIndex = 0;
	return (): Promise<ScriptResult> | ScriptResult => {
		const step = steps[Math.min(callIndex, steps.length - 1)]!;
		callIndex += 1;
		return step();
	};
}

/**
 * What a task once returned on booting another version. No task carries the
 * guard that produced it any more, so it is just an output that is not JSON.
 * @returns Result whose output is a place-mismatch message.
 */
function versionMismatchOutput(): ScriptResult {
	return { durationMs: 3, outputs: [formatPlaceMismatch(99)] };
}

function oneSuccessEntry(): ScriptResult {
	return scriptResult(envelope([{ jestOutput: successJest() }]));
}

function job({
	displayName,
	overrides = {},
	packageName,
}: {
	readonly displayName: string;
	readonly overrides?: Partial<ResolvedConfig>;
	readonly packageName?: string | undefined;
}): ConfiguredJob {
	return projectJob({
		config: {
			...createResolvedConfig(),
			placeFile: "./test.rbxl",
			...overrides,
		},
		displayColor: `${displayName}-color`,
		displayName,
		pkg: packageName,
		testFiles: [`${displayName}/test.spec.ts`],
	});
}

function request({
	jobs,
	parallel,
	progress,
	stealing,
	workspace,
}: {
	jobs: [ConfiguredJob, ...Array<ConfiguredJob>];
	parallel?: ParallelOption;
	progress?: OpenCloudDispatch["progress"];
	stealing?: true;
	workspace?: true;
}): OpenCloudDispatch {
	const base = { jobs, progress, runSettings: jobs[0].config };
	if (stealing !== undefined) {
		const [first, ...rest] = jobs.map((entry) => ({ ...entry, pkg: entry.displayName }));
		return {
			...base,
			jobs: [first, ...rest],
			sharding: { bail: false, kind: "work-stealing", parallel },
		};
	}

	if (workspace !== undefined) {
		return { ...base, sharding: { bail: false, kind: "deferrable", parallel } };
	}

	return { ...base, sharding: { kind: "static", parallel } };
}

function jobsOptions(
	jobs: [ConfiguredJob, ...Array<ConfiguredJob>],
	parallel?: ParallelOption,
): OpenCloudDispatch {
	return request({ jobs, parallel });
}

function cacheFixture() {
	const rootDirectory = path.resolve("upload-cache");
	const { fileSystem } = createMemoryFileSystem({
		[path.join(rootDirectory, "place.rbxl")]: "place-bytes",
	});
	return { fileSystem, rootDirectory };
}

function cacheJob(rootDirectory: string, overrides: Partial<ResolvedConfig> = {}): ConfiguredJob {
	return job({
		displayName: "alpha",
		overrides: { placeFile: "place.rbxl", rootDir: rootDirectory, ...overrides },
	});
}

/** The version an upload lands on wherever a spec drives {@link probeStub}. */
const PROBED_VERSION = 42;

/**
 * A runner whose upload lands on {@link PROBED_VERSION} and whose tasks pass.
 * @returns The runner stub.
 */
function probeStub(): RunnerStub {
	const stub = createRunnerStub({
		uploadResult: { uploadMs: 12, versionNumber: PROBED_VERSION },
	});
	stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));
	return stub;
}

async function runProbedRunAsync(
	{ fileSystem, rootDirectory }: ReturnType<typeof cacheFixture>,
	overrides: Partial<ResolvedConfig> = {},
): Promise<RunnerStub> {
	const stub = probeStub();
	const backend = createBackend({ fileSystem, runner: stub.runner });
	await backend.runTestsAsync(jobsOptions([cacheJob(rootDirectory, overrides)]));
	return stub;
}

const credentials = {
	apiKey: "test-api-key",
	placeId: "456",
	universeId: "123",
};

describe(OpenCloudBackend, () => {
	it.for([
		{ cause: "an uncertain create", failure: () => new Error("HTTP 500 unknown exception") },
		{ cause: "a poll timeout", failure: pollTimeout },
	])("should create one task per execution after $cause", async ({ failure }) => {
		expect.assertions(2);

		const stub = probeStub();
		stub.setExecute(
			vi
				.fn<ExecuteHandler>()
				.mockRejectedValueOnce(failure())
				.mockReturnValue(oneSuccessEntry()),
		);
		const backend = createBackend({ runner: stub.runner });

		await expect(
			backend.runTestsAsync(jobsOptions([job({ displayName: "alpha" })])),
		).rejects.toThrow(failure().message);
		expect(stub.executeCalls).toHaveLength(1);
	});

	it("should close the tests stage once every job has run", async () => {
		expect.assertions(1);

		const closed: Array<string> = [];
		const stub = probeStub();
		await createBackend({ runner: stub.runner }).runTestsAsync(
			request({
				jobs: [job({ displayName: "alpha" })],
				progress: {
					...NOOP_PROGRESS,
					begin: (id) => () => {
						closed.push(id);
					},
				},
			}),
		);

		expect(closed).toContain("tests");
	});

	it("should submit a Shared Place task with no submit budget", async () => {
		expect.assertions(1);

		const stub = probeStub();
		const backend = createBackend({ runner: stub.runner });
		await backend.runTestsAsync(request({ jobs: [job({ displayName: "alpha" })] }));

		expect(stub.executeCalls.map(({ script: _script, ...call }) => call)).toStrictEqual([
			{ bootProven: true, placeVersion: PROBED_VERSION, timeout: 300_000 },
		]);
	});

	it("should submit the boot probe without an idempotent retry or a submit budget", async () => {
		expect.assertions(1);

		const stub = probeStub();
		await createBackend({ runner: stub.runner }).runTestsAsync(
			jobsOptions([job({ displayName: "alpha" })]),
		);

		expect(stub.probeCalls).toStrictEqual([
			{
				placeVersion: PROBED_VERSION,
				pollBudget: 90_000,
				script: "return tostring(game.PlaceVersion)",
				timeout: 10_000,
			},
		]);
	});

	describe("bucketing", () => {
		it("should default to a single executeScript carrying every job's config", async () => {
			expect.assertions(4);

			const stub = createRunnerStub();
			stub.setExecute(() => {
				return scriptResult(
					envelope([
						{ gameOutput: "111", jestOutput: successJest({ numPassedTests: 1 }) },
						{ gameOutput: "222", jestOutput: successJest({ numPassedTests: 2 }) },
						{ gameOutput: "333", jestOutput: successJest({ numPassedTests: 3 }) },
					]),
				);
			});

			const backend = createBackend({ runner: stub.runner });
			const { rawResults } = await backend.runTestsAsync(
				jobsOptions([
					job({ displayName: "alpha", overrides: { testNamePattern: "alpha-pattern" } }),
					job({ displayName: "beta", overrides: { testNamePattern: "beta-pattern" } }),
					job({ displayName: "gamma", overrides: { testNamePattern: "gamma-pattern" } }),
				]),
			);

			expect(stub.executeCalls).toHaveLength(1);

			const { script } = stub.executeCalls[0]!;
			const patterns = Array.from(
				script.matchAll(/"testNamePattern":"([^"]+)"/g),
				(match) => match[1],
			);

			expect(patterns).toStrictEqual(["alpha-pattern", "beta-pattern", "gamma-pattern"]);
			expect(rawResults).toHaveLength(3);
			expect(rawResults.map((raw) => raw.entry.gameOutput)).toStrictEqual([
				"111",
				"222",
				"333",
			]);
		});

		it("should preserve snapshotFormat per job inside the bundled configs array", async () => {
			expect.assertions(2);

			const stub = createRunnerStub();
			stub.setExecute(() => {
				return scriptResult(
					envelope([{ jestOutput: successJest() }, { jestOutput: successJest() }]),
				);
			});

			const backend = createBackend({ runner: stub.runner });
			await backend.runTestsAsync(
				jobsOptions([
					job({
						displayName: "alpha",
						overrides: {
							snapshotFormat: { escapeString: true, printBasicPrototype: false },
						},
					}),
					job({
						displayName: "beta",
						overrides: {
							snapshotFormat: { escapeString: false, printBasicPrototype: true },
						},
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

			const backend = createBackend({ runner: stub.runner });
			const { rawResults } = await backend.runTestsAsync(
				jobsOptions(
					[
						job({ displayName: "alpha" }),
						job({ displayName: "beta" }),
						job({ displayName: "gamma" }),
					],
					1,
				),
			);

			expect(stub.executeCalls).toHaveLength(1);
			expect(rawResults).toHaveLength(3);
		});

		it("should populate timing.executionMs on the BackendResult", async () => {
			expect.assertions(1);

			const now = vi
				.spyOn(Date, "now")
				.mockReturnValueOnce(100)
				.mockReturnValueOnce(112)
				.mockReturnValueOnce(200)
				.mockReturnValueOnce(245);
			onTestFinished(() => {
				now.mockRestore();
			});
			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

			const backend = createBackend({ runner: stub.runner });
			const { timing } = await backend.runTestsAsync(
				jobsOptions([job({ displayName: "alpha" })]),
			);

			expect(timing).toStrictEqual({ executionMs: 45, uploadMs: 12 });
		});

		it("should fan --parallel 3 out to three executeScript calls, one bucket each", async () => {
			expect.assertions(3);

			let bucketIndex = 0;
			const stub = createRunnerStub();
			stub.setExecute(({ script }) => {
				const index = bucketIndex;
				bucketIndex += 1;
				return scriptResult(
					envelope([
						{
							gameOutput: String(index * 10),
							jestOutput: successJest({ numPassedTests: index + 1 }),
							jobIndex: scriptJobIndices(script)[0]!,
						},
					]),
				);
			});

			const backend = createBackend({ runner: stub.runner });
			const { rawResults } = await backend.runTestsAsync(
				jobsOptions(
					[
						job({ displayName: "alpha" }),
						job({ displayName: "beta" }),
						job({ displayName: "gamma" }),
					],
					3,
				),
			);

			expect(stub.executeCalls).toHaveLength(3);
			expect(rawResults).toHaveLength(3);
			expect(rawResults.map((raw) => [raw.jobIndex, raw.entry.gameOutput])).toStrictEqual([
				[0, "0"],
				[1, "10"],
				[2, "20"],
			]);
		});

		it("should round-robin 10 jobs into buckets of 4/3/3, each entry naming its job", async () => {
			expect.assertions(5);

			const bucketPatterns: Array<Array<string>> = [];
			const stub = createRunnerStub();
			stub.setExecute((options) => {
				const patterns = Array.from(
					options.script.matchAll(/"testNamePattern":"([^"]+)"/g),
					(match) => match[1]!,
				);
				bucketPatterns.push(patterns);
				const bucketIndex = bucketPatterns.length - 1;
				return scriptResult(
					envelope(
						scriptJobIndices(options.script).map((jobIndex, position) => {
							return {
								elapsedMs: bucketIndex * 100 + position,
								jestOutput: successJest(),
								jobIndex,
							};
						}),
					),
				);
			});

			const backend = createBackend({ runner: stub.runner });
			const [first, ...rest] = Array.from({ length: 10 }, (_, index) => {
				return job({
					displayName: `p${index.toString()}`,
					overrides: {
						testNamePattern: `pattern-${index.toString()}`,
					},
				});
			});

			const { rawResults } = await backend.runTestsAsync(jobsOptions([first!, ...rest], 3));

			expect(stub.executeCalls).toHaveLength(3);
			expect(bucketPatterns[0]).toStrictEqual([
				"pattern-0",
				"pattern-3",
				"pattern-6",
				"pattern-9",
			]);
			expect(bucketPatterns[1]).toStrictEqual(["pattern-1", "pattern-4", "pattern-7"]);
			expect(bucketPatterns[2]).toStrictEqual(["pattern-2", "pattern-5", "pattern-8"]);
			expect(rawResults.map((raw) => raw.jobIndex)).toStrictEqual([
				0, 3, 6, 9, 1, 4, 7, 2, 5, 8,
			]);
		});

		it("should reject the whole call when any parallel bucket fails first", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(
				stepExecute([
					oneSuccessEntry,
					oneSuccessEntry,
					() => {
						throw new Error("bucket two blew up");
					},
				]),
			);

			const backend = createBackend({ runner: stub.runner });

			await expect(
				backend.runTestsAsync(
					jobsOptions(
						[
							job({ displayName: "alpha" }),
							job({ displayName: "beta" }),
							job({ displayName: "gamma" }),
						],
						3,
					),
				),
			).rejects.toThrowWithMessage(Error, "bucket two blew up");
		});
	});

	describe("envelope parsing", () => {
		it("should expose outputs[1] as the fallback gameOutput on each rawResult", async () => {
			expect.assertions(1);

			const fallback = JSON.stringify([
				{ message: "fallback", messageType: 0, timestamp: 0 },
			]);
			const stub = createRunnerStub();
			stub.setExecute(() => {
				return scriptResult(envelope([{ jestOutput: successJest() }]), fallback);
			});

			const backend = createBackend({ runner: stub.runner });
			const { rawResults } = await backend.runTestsAsync(
				jobsOptions([job({ displayName: "alpha" })]),
			);

			expect(rawResults[0]!.fallbackGameOutput).toBe(fallback);
		});

		it("should throw when executeScript returns no outputs", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => ({ durationMs: 0, outputs: [] }));

			const backend = createBackend({ runner: stub.runner });

			await expect(
				backend.runTestsAsync(jobsOptions([job({ displayName: "alpha" })])),
			).rejects.toThrow(/No test results in output/);
		});

		it("should expose multi-entry rawResults with their job indices", async () => {
			expect.assertions(2);

			const stub = createRunnerStub();
			stub.setExecute(() => {
				return scriptResult(
					envelope([
						{ gameOutput: "11", jestOutput: successJest(), pkg: "@halcyon/foo" },
						{ gameOutput: "22", jestOutput: successJest(), pkg: "@halcyon/bar" },
						{ gameOutput: "33", jestOutput: successJest(), pkg: "@halcyon/baz" },
					]),
				);
			});

			const backend = createBackend({ runner: stub.runner });
			const { rawResults } = await backend.runTestsAsync(
				jobsOptions([
					job({ displayName: "@halcyon/foo" }),
					job({ displayName: "@halcyon/bar" }),
					job({ displayName: "@halcyon/baz" }),
				]),
			);

			expect(rawResults).toHaveLength(3);
			expect(rawResults.map((raw) => [raw.jobIndex, raw.entry.gameOutput])).toStrictEqual([
				[0, "11"],
				[1, "22"],
				[2, "33"],
			]);
		});
	});

	describe("upload integration", () => {
		it("should call runner.uploadPlaceAsync exactly once regardless of bucket count", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

			const backend = createBackend({ runner: stub.runner });
			await backend.runTestsAsync(
				jobsOptions(
					[
						job({ displayName: "alpha" }),
						job({ displayName: "beta" }),
						job({ displayName: "gamma" }),
						job({ displayName: "delta" }),
					],
					4,
				),
			);

			expect(stub.uploadCalls).toHaveLength(1);
		});

		it("should propagate upload errors from the runner", async () => {
			expect.assertions(1);

			const stub = createRunnerStub({
				uploadError: new Error("Failed to upload place: 401"),
			});
			const backend = createBackend({ runner: stub.runner });

			await expect(
				backend.runTestsAsync(jobsOptions([job({ displayName: "alpha" })])),
			).rejects.toThrow(/Failed to upload place/);
		});
	});

	describe("work-stealing", () => {
		it("should fire N tasks all carrying the same scriptOverride and upload once", async () => {
			expect.assertions(3);

			const taskPkgs = [
				["alpha", "delta"],
				["beta", "epsilon"],
				["gamma", "zeta"],
			] as const;
			const stub = createRunnerStub();
			stub.setExecute(
				stepExecute(
					taskPkgs.map((handledPkgs) => {
						return () => scriptResult(envelope(handledPkgs.map(packageEntry)));
					}),
				),
			);

			const backend = createBackend({ runner: stub.runner });
			await backend.runTestsAsync(
				request({
					jobs: [
						job({ displayName: "alpha" }),
						job({ displayName: "beta" }),
						job({ displayName: "gamma" }),
						job({ displayName: "delta" }),
						job({ displayName: "epsilon" }),
						job({ displayName: "zeta" }),
					],
					parallel: 3,
					stealing: true,
				}),
			);

			expect(stub.executeCalls).toHaveLength(3);

			const scripts = new Set(stub.executeCalls.map((call) => call.script));

			expect(scripts.size).toBe(1);
			expect(stub.uploadCalls).toHaveLength(1);
		});

		it("should not replenish a freed slot — single-wave fires exactly parallel tasks", async () => {
			expect.assertions(1);

			// One task returns immediately while the other lingers. The shared
			// pool would relaunch the freed slot if jest didn't pass a no-op
			// replenishment; single-wave must fire exactly `parallel` tasks total
			// and never start a replacement when a slot drains early.
			const stub = createRunnerStub();
			stub.setExecute(
				stepExecute([
					() => scriptResult(envelope([packageEntry("alpha")])),
					async () => {
						await new Promise<void>((resolve) => {
							setTimeout(resolve, 10);
						});
						return scriptResult(envelope([packageEntry("beta")]));
					},
				]),
			);

			const backend = createBackend({ runner: stub.runner });
			await backend.runTestsAsync(
				request({
					jobs: [job({ displayName: "alpha" }), job({ displayName: "beta" })],
					parallel: 2,
					stealing: true,
				}),
			);

			expect(stub.executeCalls).toHaveLength(2);
		});

		it("should shard a workspace run across one task per bucket", async () => {
			expect.assertions(2);

			// A workspace run knows every entry up front, so the factory can
			// carve them into one script per bucket. Without the queue that
			// is the only concurrency left, and multi mode already gets it.
			const stub = createRunnerStub();
			stub.setExecute(scriptedEntries);

			const backend = createBackend({ runner: stub.runner });
			const results = await backend.runTestsAsync(
				request({
					jobs: [
						job({ displayName: "alpha", packageName: "alpha" }),
						job({ displayName: "beta", packageName: "beta" }),
						job({ displayName: "gamma", packageName: "gamma" }),
					],
					parallel: 3,
					workspace: true,
				}),
			);

			expect(results.rawResults).toHaveLength(3);
			expect(stub.executeCalls.map(requestedNames)).toStrictEqual([
				["alpha"],
				["beta"],
				["gamma"],
			]);
		});

		it("should build the first script as the materializer for the jobs", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([packageEntry("alpha")])));

			const backend = createBackend({ runner: stub.runner });
			await backend.runTestsAsync(
				request({
					jobs: [job({ displayName: "alpha", packageName: "alpha" })],
					workspace: true,
				}),
			);

			expect(requestedNames(stub.executeCalls[0]!)).toStrictEqual(["alpha"]);
		});

		// --bail stops the run on the first failing package, so the packages
		// after it have no entry by design. Reporting them as bailed is what
		// separates that from a task that broke and lost its results.
		it("should preserve bail evidence when only one work-stealing task bails", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(
				stepExecute([
					() => scriptResult(envelope([packageEntry("alpha")], { bailed: true })),
					() => scriptResult(envelope([packageEntry("beta")])),
				]),
			);
			const backend = createBackend({ runner: stub.runner });

			const result = await backend.runTestsAsync(
				request({
					jobs: [
						job({ displayName: "alpha" }),
						job({ displayName: "beta" }),
						job({ displayName: "gamma" }),
					],
					parallel: 2,
					stealing: true,
				}),
			);

			expect(result).toMatchObject({
				bailed: true,
				rawResults: [{ jobIndex: 0 }, { jobIndex: 1 }],
			});
		});

		it("should aggregate entries from all task envelopes by the job each names", async () => {
			expect.assertions(2);

			const taskPkgs = [
				["alpha", "gamma"],
				["beta", "delta"],
			];
			let taskIndex = 0;
			const stub = createRunnerStub();
			stub.setExecute(() => {
				const pkgs = taskPkgs[taskIndex]!;
				taskIndex += 1;
				return scriptResult(envelope(pkgs.map(packageEntry)));
			});

			const backend = createBackend({ runner: stub.runner });
			const { rawResults } = await backend.runTestsAsync(
				request({
					jobs: [
						job({ displayName: "alpha" }),
						job({ displayName: "beta" }),
						job({ displayName: "gamma" }),
						job({ displayName: "delta" }),
					],
					parallel: 2,
					stealing: true,
				}),
			);

			// These results cross the backend boundary; pin every job/entry field
			// while retaining the readable ordering assertions below.
			expect(rawResults).toMatchSnapshot();

			expect(rawResults.map((raw) => raw.jobIndex)).toStrictEqual([0, 2, 1, 3]);
		});

		it("should set up the queue with the run's credentials and base URL", async () => {
			expect.assertions(1);

			vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_BASE_URL", "http://127.0.0.1:4010/");
			const prepareWorkStealingQueue = stubQueue();
			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([packageEntry("alpha")])));
			const backend = createBackend({ prepareWorkStealingQueue, runner: stub.runner });

			await backend.runTestsAsync(
				request({ jobs: [job({ displayName: "alpha" })], parallel: 2, stealing: true }),
			);

			expect(prepareWorkStealingQueue.mock.calls[0]![0]).toMatchObject({
				baseUrl: "http://127.0.0.1:4010",
				credentials: { apiKey: credentials.apiKey, universeId: credentials.universeId },
			});
		});

		it("should throw when work-stealing executeScript returns no outputs", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => ({ durationMs: 0, outputs: [] }));

			const backend = createBackend({ runner: stub.runner });

			await expect(
				backend.runTestsAsync(
					request({
						jobs: [job({ displayName: "alpha" })],
						parallel: 1,
						stealing: true,
					}),
				),
			).rejects.toThrow(/No test results in output/);
		});
	});
});

describe("construction", () => {
	it("should construct an OpenCloudBackend from given credentials", () => {
		expect.assertions(1);

		const backend = new OpenCloudBackend(credentials);

		expect(backend).toBeInstanceOf(OpenCloudBackend);
	});

	it("should construct the default runner with JEST_ROBLOX_OCALE_MAX_RETRIES set", () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_OCALE_MAX_RETRIES", "8");

		const backend = new OpenCloudBackend(credentials);

		expect(backend).toBeInstanceOf(OpenCloudBackend);
	});
});

describe("upload cache", () => {
	/**
	 * How many uploads one passing run made.
	 * @param fixture - Cache fixture of the spec.
	 * @param overrides - Config overrides.
	 * @returns Upload count.
	 */
	async function runOnceAsync(
		fixture: ReturnType<typeof cacheFixture>,
		overrides: Partial<ResolvedConfig> = {},
	): Promise<number> {
		const { uploadCalls } = await runProbedRunAsync(fixture, overrides);
		return uploadCalls.length;
	}

	function apiError(statusCode: number): Error {
		const cause = Object.assign(new Error(`HTTP ${String(statusCode)}`), { statusCode });
		return new Error("execute failed", { cause });
	}

	it("should clear a suspect cache without restarting dispatched tests", async () => {
		expect.assertions(4);

		const fixture = cacheFixture();
		const { fileSystem, rootDirectory } = fixture;
		await runOnceAsync(fixture);
		const capture = captureStderr();
		const failure = apiError(404);
		const stub = createRunnerStub();
		stub.setExecute(() => {
			throw failure;
		});
		const backend = createBackend({ fileSystem, runner: stub.runner });

		await expect(backend.runTestsAsync(jobsOptions([cacheJob(rootDirectory)]))).rejects.toBe(
			failure,
		);
		expect(stub.executeCalls).toHaveLength(1);
		expect(capture.writes.join("")).toContain(
			"clearing the upload cache without restarting dispatched tests",
		);
		await expect(runOnceAsync(fixture)).resolves.toBe(1);
	});

	it("should report cache lookup time separately from execution", async () => {
		expect.assertions(1);

		const fixture = cacheFixture();
		const { fileSystem, rootDirectory } = fixture;
		await runOnceAsync(fixture);
		vi.spyOn(Date, "now")
			.mockReturnValueOnce(100)
			.mockReturnValueOnce(101)
			.mockReturnValueOnce(200)
			.mockReturnValue(222);
		const stub = createRunnerStub();
		stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));
		const backend = createBackend({ fileSystem, runner: stub.runner });
		const result = await backend.runTestsAsync(jobsOptions([cacheJob(rootDirectory)]));

		expect(result.timing).toStrictEqual({ executionMs: 22, uploadMs: 1 });
	});
});

/**
 * A Shared Place run submits everything to the Exact Version its upload
 * returned. Nothing goes to head, so no task carries a guard and none is
 * retried pinned: the first submission is already the right one.
 */
describe("exact version submission", () => {
	it("should pin the boot probe to the uploaded version", async () => {
		expect.assertions(2);

		const stub = probeStub();
		const backend = createBackend({ runner: stub.runner });
		await backend.runTestsAsync(jobsOptions([job({ displayName: "alpha" })]));

		expect(stub.probeCalls).toHaveLength(1);
		expect(stub.probeCalls[0]).toMatchObject({
			placeVersion: PROBED_VERSION,
			script: "return tostring(game.PlaceVersion)",
		});
	});

	/** A 5xx create may still have counted against the create limit. */
	it("should not re-send a probe create that Open Cloud answered with a 5xx", async () => {
		expect.assertions(1);

		const stub = probeStub();
		const backend = createBackend({ runner: stub.runner });
		await backend.runTestsAsync(jobsOptions([job({ displayName: "alpha" })]));

		expect(stub.probeCalls[0]!.isSubmitIdempotent).not.toBeTrue();
	});

	it("should pin every bucket to the uploaded version with no guard", async () => {
		expect.assertions(2);

		const stub = probeStub();
		const backend = createBackend({ runner: stub.runner });
		await backend.runTestsAsync(
			jobsOptions(
				[
					job({ displayName: "alpha" }),
					job({ displayName: "beta" }),
					job({ displayName: "gamma" }),
				],
				3,
			),
		);

		// 3 jobs at parallel 3 => one bucket each => exactly 3 calls.
		expect(stub.executeCalls.map((call) => call.placeVersion)).toStrictEqual([
			PROBED_VERSION,
			PROBED_VERSION,
			PROBED_VERSION,
		]);
		expect(stub.executeCalls.some((call) => call.script.includes(PLACE_MISMATCH))).toBeFalse();
	});

	it("should pin work-stealing tasks and hand them the script as written", async () => {
		expect.assertions(2);

		const stub = createRunnerStub({ uploadResult: { uploadMs: 12, versionNumber: 7 } });
		stub.setExecute(() => scriptResult(envelope([packageEntry("alpha")])));
		const backend = createBackend({ runner: stub.runner });
		await backend.runTestsAsync(
			request({
				jobs: [job({ displayName: "alpha" })],
				stealing: true,
			}),
		);

		expect(stub.executeCalls[0]!.placeVersion).toBe(7);
		expect(stub.executeCalls[0]!.script).toContain('"queueId":"queue-1"');
	});

	it("should treat a version mismatch sentinel as a malformed result", async () => {
		expect.assertions(2);

		const stub = probeStub();
		stub.setExecute(versionMismatchOutput);
		const backend = createBackend({ runner: stub.runner });

		await expect(
			backend.runTestsAsync(jobsOptions([job({ displayName: "alpha" })])),
		).rejects.toThrow("is not valid JSON");
		expect(stub.executeCalls).toHaveLength(1);
	});
});

/**
 * What the runner throws when a task never reaches a terminal state.
 * @returns Error caused by a poll timeout.
 */
function pollTimeout(): Error {
	return new Error("Execution timed out: Roblox never reported a terminal state", {
		cause: new PollTimeoutError("poll budget exhausted", { timeoutMs: 135_000 }),
	});
}

describe("boot probe", () => {
	/** A lost probe says nothing about the place. */
	it("should send one more probe when the first is lost, then run the tests", async () => {
		expect.assertions(4);

		const stub = probeStub();
		stub.setProbe(
			stepExecute([
				() => {
					throw pollTimeout();
				},
				() => ({ durationMs: 0, outputs: [String(PROBED_VERSION)] }),
			]),
		);
		const backend = createBackend({ runner: stub.runner });

		await backend.runTestsAsync(jobsOptions([job({ displayName: "alpha" })]));

		expect(stub.probeCalls).toHaveLength(2);
		expect(stub.probeCalls[1]!.placeVersion).toBe(PROBED_VERSION);
		expect(stub.executeCalls).toHaveLength(1);
		expect(stub.executeCalls[0]!.bootProven).toBeTrue();
	});

	/**
	 * The cache entry is written only once the probe passes, so a hit already
	 * carries the proof. Re-probing would spend a boot on a question already
	 * answered, on every run that reuses a version.
	 */
	it("should skip the probe and pin the tests to the version the upload cache reused", async () => {
		expect.assertions(4);

		const fixture = cacheFixture();

		const first = await runProbedRunAsync(fixture);
		const second = await runProbedRunAsync(fixture);

		expect(first.probeCalls).toHaveLength(1);
		expect(second.uploadCalls).toHaveLength(0);
		expect(second.probeCalls).toHaveLength(0);
		expect(second.executeCalls[0]!.placeVersion).toBe(PROBED_VERSION);
	});

	/**
	 * The runner falls back to naming a place Roblox cannot load when a task
	 * never settles. The probe has just disproved that for these bytes, so a
	 * later timeout must not send the reader to Studio over it.
	 */
	it("should tell the runner the place boots once the probe has passed", async () => {
		expect.assertions(2);

		const stub = probeStub();

		const backend = createBackend({ runner: stub.runner });
		await backend.runTestsAsync(jobsOptions([job({ displayName: "alpha" })]));

		expect(stub.executeCalls).toHaveLength(1);
		expect(stub.executeCalls[0]!.bootProven).toBeTrue();
	});

	/**
	 * A cache entry says the bytes booted when it was written, which is not
	 * the same claim, so a reused version leaves the runner its own reading.
	 */
	it("should leave the runner to guess when the version came from the cache", async () => {
		expect.assertions(1);

		const fixture = cacheFixture();

		await runProbedRunAsync(fixture);
		const second = await runProbedRunAsync(fixture);

		expect(second.executeCalls[0]!.bootProven).toBeFalse();
	});

	/**
	 * The budget is wall clock, not a task deadline: the poll must stop asking
	 * at the budget, or a 90s probe waits out the runner's boot-lag allowance
	 * on top and the failure arrives 45s after it was known.
	 *
	 * The deadline stays short and separate. Set to the whole budget the two
	 * would expire together, so a place that booted just inside the budget
	 * would be reported as one Roblox cannot start while its script ran — the
	 * one verdict that has to be trustworthy.
	 */
	it("should give the probe its own budget, 90s by default", async () => {
		expect.assertions(3);

		const stub = createRunnerStub();
		stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

		const backend = createBackend({ runner: stub.runner });
		await backend.runTestsAsync(jobsOptions([job({ displayName: "alpha" })]));

		expect(stub.probeCalls[0]!.pollBudget).toBe(90_000);
		expect(stub.probeCalls[0]!.timeout).toBeLessThan(90_000);
		expect(stub.executeCalls[0]!.timeout).toBe(createResolvedConfig().timeout);
	});
});
