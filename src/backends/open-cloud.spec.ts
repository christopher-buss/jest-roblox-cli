import { PollTimeoutError } from "@bedrock-rbx/ocale";
import { placeIdentityGuardSource } from "@isentinel/roblox-runner";
import type {
	BinaryInputUploader,
	ExecuteScriptOptions,
	RemoteRunner,
	ScriptResult,
	UploadBinaryInputOptions,
	UploadBinaryInputResult,
	UploadPlaceOptions,
	UploadPlaceResult,
} from "@isentinel/roblox-runner";
import { formatPlaceMismatch, PLACE_MISMATCH } from "@isentinel/roblox-runner/testing";

import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import claimSource from "../../luau/execution-claim.luau";
import { startFakeOpenCloudServerAsync } from "../../test/e2e/cli/fake-open-cloud.ts";
import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { ConfigError } from "../config/errors.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { CODE_BUNDLE_REBUILD_SOURCE } from "../luau/code-bundle-rebuild.ts";
import { prepareTaskScript } from "../luau/task-script.ts";
import type {
	StreamingResultReader,
	StreamingResultRecord,
} from "../memory-store/sorted-map-client.ts";
import { NOOP_RUN_PROGRESS } from "../progress/reporter.ts";
import type { StageId } from "../progress/stages.ts";
import type { CodeBundleArtifact } from "../staging/place-builder.ts";
import type { JestResult } from "../types/jest-result.ts";
import type { BackendOptions, ProjectJob } from "./interface.ts";
import {
	BOOT_PROBE_SCRIPT,
	createOpenCloudBackend,
	OpenCloudBackend,
	resolveOcaleMaxRetries,
	resolveOpenCloudBaseUrl,
} from "./open-cloud.ts";

interface StubStreamReader extends StreamingResultReader {
	deleted: Array<string>;
	readCalls: number;
}

interface RunnerStubOptions {
	binaryInputError?: Error;
	/**
	 * The path each create hands back, one per call. A run that refreshes its
	 * input reads the second, so the spec can tell the two submits apart.
	 */
	binaryInputPaths?: Array<string>;
	/** What the runner reports the upload cost, which the run adds on. */
	binaryInputUploadMs?: number;
	uploadError?: Error;
	uploadResult?: UploadPlaceResult;
}

type ExecuteHandler = (options: ExecuteScriptOptions) => Promise<ScriptResult> | ScriptResult;

type ExecuteStep = () => Promise<ScriptResult> | ScriptResult;

interface RunnerStub {
	/** One entry per binary-input create, carrying the bytes it was handed. */
	binaryInputCalls: Array<UploadBinaryInputOptions>;
	executeCalls: Array<ExecuteScriptOptions>;
	/** Boot-probe submits, kept apart so a test counts only its own tasks. */
	probeCalls: Array<ExecuteScriptOptions>;
	runner: BinaryInputUploader & RemoteRunner;
	setExecute: (handler: ExecuteHandler) => void;
	setProbe: (handler: ExecuteHandler) => void;
	uploadCalls: Array<UploadPlaceOptions>;
}

/**
 * Verify the entire claim, then compare the task's remaining preambles and
 * body.
 */
function claimParameters(script: string): string {
	const parameters = /local key, startBefore, retention, notClaimed, startExpired = (.+)/.exec(
		script,
	)?.[1];
	if (parameters === undefined) {
		throw new Error("Missing execution claim parameters");
	}

	return parameters;
}

function withoutClaim(script: string): string {
	const parameters = claimParameters(script);
	const claim = `${claimSource.replace("__EXECUTION_CLAIM_PARAMETERS__", () => parameters)}\n`;
	if (!script.includes(claim)) {
		throw new Error("Incomplete execution claim");
	}

	return script.replace(claim, "");
}

function createStreamReader(pages: Array<Array<StreamingResultRecord>>): StubStreamReader {
	const reader: StubStreamReader = {
		deleteAsync: async (itemId): Promise<void> => {
			reader.deleted.push(itemId);
		},
		deleted: [],
		readAllAsync: async (): Promise<Array<StreamingResultRecord>> => {
			const index = Math.min(reader.readCalls, pages.length - 1);
			reader.readCalls += 1;
			return pages[index] ?? [];
		},
		readCalls: 0,
	};
	return reader;
}

const DEFAULT_UPLOAD: UploadPlaceResult = { uploadMs: 12, versionNumber: 1 };

/** The resource path a create hands back unless a spec names its own. */
const DEFAULT_BINARY_INPUT_PATH = "universes/123/luau-execution-session-task-binary-inputs/input-1";

interface StderrCapture {
	restore: () => void;
	writes: Array<string>;
}

function createRunnerStub(options: RunnerStubOptions = {}): RunnerStub {
	const binaryInputCalls: Array<UploadBinaryInputOptions> = [];
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

	// The probe is infrastructure, not one of the run's tasks: routing it to
	// its own list and its own handler keeps every other test written as
	// though it did not exist.
	async function executeScriptAsync(executeOptions: ExecuteScriptOptions): Promise<ScriptResult> {
		if (executeOptions.script === BOOT_PROBE_SCRIPT) {
			probeCalls.push(executeOptions);
			return probeHandler(executeOptions);
		}

		executeCalls.push(executeOptions);
		return executeHandler(executeOptions);
	}

	async function uploadBinaryInputAsync(
		binaryOptions: UploadBinaryInputOptions,
	): Promise<UploadBinaryInputResult> {
		binaryInputCalls.push(binaryOptions);
		if (options.binaryInputError !== undefined) {
			throw options.binaryInputError;
		}

		const paths = options.binaryInputPaths ?? [DEFAULT_BINARY_INPUT_PATH];
		// The last path answers every later create, so a spec naming one path
		// gets it back however many times the run asks.
		const index = Math.min(binaryInputCalls.length - 1, paths.length - 1);
		return { path: paths[index]!, uploadMs: options.binaryInputUploadMs ?? 7 };
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
		binaryInputCalls,
		executeCalls,
		probeCalls,
		runner: { executeScriptAsync, uploadBinaryInputAsync, uploadPlaceAsync },
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

function envelope(
	entries: Array<{
		elapsedMs?: number;
		gameOutput?: string;
		jestOutput: string;
		pkg?: string;
		project?: string;
	}>,
	options: { bailed?: boolean; deferred?: boolean } = {},
): string {
	return JSON.stringify({ ...options, entries });
}

function packageEntry(packageName: string) {
	return { jestOutput: successJest(), pkg: packageName };
}

function scriptResult(jestOutput: string, gameOutput = "[]"): ScriptResult {
	return { durationMs: 5, outputs: [jestOutput, gameOutput] };
}

/** A workspace script factory that spells out the jobs it was handed. */
function scriptNaming(jobs: ReadonlyArray<ProjectJob>): string {
	return `entries:${jobs.map((entry) => entry.displayName).join(",")}`;
}

/**
 * The packages a {@link scriptNaming} script carries, read back off the
 * submitted task — the guard prefix an unpinned attempt gains sits
 * ahead of the marker, so the split survives it.
 */
function requestedNames(options: ExecuteScriptOptions): Array<string> {
	return options.script.split("entries:", 2)[1]!.split(",");
}

/** An envelope answering exactly the packages a script asked for. */
function scriptedEntries(options: ExecuteScriptOptions): ScriptResult {
	return scriptResult(envelope(requestedNames(options).map(packageEntry)));
}

/**
 * An execute handler that answers every script with the packages it asked
 * for, except one carrying more than one entry and leading with
 * `deferringHead` — that comes back deferred, having run only the head.
 */
function deferOnceExecute(deferringHead: string): ExecuteHandler {
	return (options): ScriptResult => {
		const requested = requestedNames(options);
		return requested.length > 1 && requested[0] === deferringHead
			? scriptResult(envelope([packageEntry(deferringHead)], { deferred: true }))
			: scriptedEntries(options);
	};
}

/**
 * An execute handler where the bucket whose script leads with `bailingHead`
 * stops on it: one entry back, flagged bailed and not deferred, so that
 * bucket's chain ends there and the rest of its share never runs. Every
 * other bucket answers in full.
 */
function bailingBucketExecute(bailingHead: string): ExecuteHandler {
	return (options): ScriptResult => {
		return requestedNames(options)[0] === bailingHead
			? scriptResult(envelope([packageEntry(bailingHead)], { bailed: true }))
			: scriptedEntries(options);
	};
}

/**
 * An execute handler that runs `steps[callIndex]`, repeating the final step
 * once the list is exhausted. Keeps per-call-index dispatch out of `it`
 * bodies.
 */
function stepExecute(steps: Array<ExecuteStep>): ExecuteHandler {
	let callIndex = 0;
	return (): Promise<ScriptResult> | ScriptResult => {
		const step = steps[Math.min(callIndex, steps.length - 1)]!;
		callIndex += 1;
		return step();
	};
}

/** What the injected guard returns from a task that booted another version. */
function racedOnce(bootedVersion = 99): ScriptResult {
	return {
		durationMs: 3,
		outputs: [formatPlaceMismatch(bootedVersion)],
	};
}

function oneSuccessEntry(): ScriptResult {
	return scriptResult(envelope([{ jestOutput: successJest() }]));
}

/**
 * An execute handler that races each unpinned call in turn, booting the named
 * versions in order — one per raced task, so a run can mix causes. Later
 * unpinned calls, and every pinned retry, succeed.
 */
function raceBootedVersions(bootedVersions: Array<number>): ExecuteHandler {
	let callIndex = 0;
	return (options): ScriptResult => {
		if (options.placeVersion !== undefined) {
			return oneSuccessEntry();
		}

		const booted = bootedVersions[callIndex];
		callIndex += 1;
		return booted === undefined ? oneSuccessEntry() : racedOnce(booted);
	};
}

/**
 * An execute handler that races the first `raceCount` unpinned calls — all
 * booting the same version — and succeeds on every other call, including a
 * pinned retry (`placeVersion` set), which never races.
 */
function raceUnpinnedExecute(raceCount: number, bootedVersion = 99): ExecuteHandler {
	return raceBootedVersions(Array.from<number>({ length: raceCount }).fill(bootedVersion));
}

/**
 * The exact guard line `executeGuarded` prepends to unpinned first attempts.
 */
function guardPrefix(placeVersion: number): string {
	return `${placeIdentityGuardSource({ placeVersion })}\n`;
}

function captureStderr(): StderrCapture {
	const writes: Array<string> = [];
	const spy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk: Parameters<typeof process.stderr.write>[0]) => {
			writes.push(typeof chunk === "string" ? chunk : String(chunk));
			return true;
		});

	return {
		restore: () => {
			spy.mockRestore();
		},
		writes,
	};
}

function job(
	displayName: string,
	overrides: Partial<ResolvedConfig> = {},
	packageName?: string,
): ProjectJob {
	return {
		config: {
			...DEFAULT_CONFIG,
			placeFile: "./test.rbxl",
			...overrides,
		},
		displayColor: `${displayName}-color`,
		displayName,
		pkg: packageName,
		testFiles: [`${displayName}/test.spec.ts`],
	};
}

function jobsOptions(
	jobs: Array<ProjectJob>,
	parallel?: BackendOptions["parallel"],
): BackendOptions {
	return parallel === undefined ? { jobs } : { jobs, parallel };
}

/**
 * A temp rootDir holding a real place file — the upload cache reads bytes off
 * disk, and this spec deliberately does not mock `node:fs`.
 */
function temporaryRoot(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jest-roblox-upload-cache-"));
	fs.writeFileSync(path.join(directory, "place.rbxl"), "place-bytes");
	onTestFinished(() => {
		fs.rmSync(directory, { force: true, recursive: true });
	});

	return directory;
}

/**
 * Forward fixture traffic while rejecting a default production URL locally.
 */
function localOnlyFetch(
	baseUrl: string,
	fetchAsync: typeof globalThis.fetch,
): typeof globalThis.fetch {
	return async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.startsWith(baseUrl)) {
			return fetchAsync(input, init);
		}

		return new Response(
			JSON.stringify({ error: { message: "Unexpected non-local request" } }),
			{
				headers: { "content-type": "application/json" },
				status: 401,
			},
		);
	};
}

function cacheJob(rootDirectory: string, overrides: Partial<ResolvedConfig> = {}): ProjectJob {
	return job("alpha", { placeFile: "place.rbxl", rootDir: rootDirectory, ...overrides });
}

/** The version an upload lands on wherever a spec drives {@link probeStub}. */
const PROBED_VERSION = 42;

/**
 * A runner whose upload lands on {@link PROBED_VERSION} and whose tasks pass.
 */
function probeStub(): RunnerStub {
	const stub = createRunnerStub({
		uploadResult: { uploadMs: 12, versionNumber: PROBED_VERSION },
	});
	stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));
	return stub;
}

/** One passing run against `rootDirectory`, returning the stub it drove. */
async function runProbedRunAsync(
	rootDirectory: string,
	overrides: Partial<ResolvedConfig> = {},
): Promise<RunnerStub> {
	const stub = probeStub();
	const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
	await backend.runTestsAsync(jobsOptions([cacheJob(rootDirectory, overrides)]));
	return stub;
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

			await expect(backend.runTestsAsync({ jobs: [] })).rejects.toThrow(
				"OpenCloudBackend requires at least one job",
			);
		});

		it("should throw when --parallel is less than 1", async () => {
			expect.assertions(1);

			const { runner } = createRunnerStub();
			const backend = new OpenCloudBackend(credentials, { runner });

			await expect(backend.runTestsAsync(jobsOptions([job("alpha")], 0))).rejects.toThrow(
				/--parallel must be >= 1/,
			);
		});

		it("should require scriptOverride when workStealing is true", async () => {
			expect.assertions(1);

			const { runner } = createRunnerStub();
			const backend = new OpenCloudBackend(credentials, { runner });

			await expect(
				backend.runTestsAsync({ jobs: [job("alpha")], workStealing: true }),
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
			const { rawResults } = await backend.runTestsAsync(
				jobsOptions([
					job("alpha", { testNamePattern: "alpha-pattern" }),
					job("beta", { testNamePattern: "beta-pattern" }),
					job("gamma", { testNamePattern: "gamma-pattern" }),
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
			await backend.runTestsAsync(
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
			const { rawResults } = await backend.runTestsAsync(
				jobsOptions([job("alpha"), job("beta"), job("gamma")], 1),
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
				.mockReturnValueOnce(200)
				.mockReturnValueOnce(245);
			onTestFinished(() => {
				now.mockRestore();
			});
			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { timing } = await backend.runTestsAsync(jobsOptions([job("alpha")]));

			expect(timing).toStrictEqual({ executionMs: 45, uploadMs: 12 });
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
			const { rawResults } = await backend.runTestsAsync(
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
				const patterns = Array.from(
					options.script.matchAll(/"testNamePattern":"([^"]+)"/g),
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

			const { rawResults } = await backend.runTestsAsync(jobsOptions(jobs, 3));

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

			await backend.runTestsAsync(jobsOptions(jobs, "auto"));

			expect(stub.executeCalls).toHaveLength(3);
		});

		it("should cap --parallel auto at jobs.length when jobs are fewer than the auto ceiling", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync(jobsOptions([job("alpha"), job("beta")], "auto"));

			expect(stub.executeCalls).toHaveLength(2);
		});

		it("should cap --parallel n at jobs.length when n exceeds the job count", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync(jobsOptions([job("alpha"), job("beta")], 10));

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

			await expect(backend.runTestsAsync(jobsOptions([job("alpha")]))).rejects.toThrow(
				/Open Cloud backend returned 2 entries but bucket had 1 jobs/,
			);
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

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			await expect(
				backend.runTestsAsync(jobsOptions([job("alpha"), job("beta"), job("gamma")], 3)),
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
			await backend.runTestsAsync({ jobs: [job("alpha")], scriptOverride: customScript });

			expect(withoutClaim(stub.executeCalls[0]!.script)).toBe(
				`${guardPrefix(1)}${customScript}`,
			);
			expect(stub.executeCalls[0]!.script).not.toContain("Jest.runCLI");
		});

		/**
		 * A static split sends one script to every bucket, and the composition
		 * depends on nothing that varies between them — so it happens once for
		 * the wave rather than once per bucket, over a script that carries the
		 * whole test harness.
		 */
		it("should compose one script for every bucket of a static split", async () => {
			expect.assertions(3);

			const stub = createRunnerStub();
			stub.setExecute(() => {
				return scriptResult(envelope([{ jestOutput: successJest(), pkg: "@halcyon/foo" }]));
			});
			// Wrapped rather than replaced: every other assertion reads the
			// script the real composer produced, and only the call count says
			// whether the run composed it once or once per bucket.
			const prepareScript = vi.fn<typeof prepareTaskScript>(prepareTaskScript);

			const backend = new OpenCloudBackend(credentials, {
				prepareScript,
				runner: stub.runner,
			});
			await backend.runTestsAsync({
				jobs: [job("alpha"), job("beta"), job("gamma")],
				parallel: 3,
				scriptOverride: "-- shared\nreturn nil",
			});
			const scripts = new Set(stub.executeCalls.map((call) => call.script));

			expect(stub.executeCalls).toHaveLength(3);
			expect(prepareScript).toHaveBeenCalledOnce();
			expect(scripts.size).toBe(3);
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

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { rawResults } = await backend.runTestsAsync(jobsOptions([job("alpha")]));

			expect(rawResults[0]!.fallbackGameOutput).toBe(fallback);
		});

		it("should throw when executeScript returns no outputs", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => ({ durationMs: 0, outputs: [] }));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			await expect(backend.runTestsAsync(jobsOptions([job("alpha")]))).rejects.toThrow(
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
			const { rawResults } = await backend.runTestsAsync(
				jobsOptions([job("@halcyon/foo"), job("@halcyon/bar"), job("@halcyon/baz")]),
			);

			expect(rawResults).toHaveLength(3);
			expect(rawResults.map((raw) => raw.entry.elapsedMs)).toStrictEqual([11, 22, 33]);
		});
	});

	describe("upload integration", () => {
		it("should call runner.uploadPlaceAsync exactly once regardless of bucket count", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync(
				jobsOptions([job("alpha"), job("beta"), job("gamma"), job("delta")], 4),
			);

			expect(stub.uploadCalls).toHaveLength(1);
		});

		it("should run every bucket unpinned with a version guard prepended", async () => {
			expect.assertions(3);

			const stub = createRunnerStub({
				uploadResult: { uploadMs: 12, versionNumber: 42 },
			});
			stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync(jobsOptions([job("alpha"), job("beta"), job("gamma")], 3));

			// 3 jobs at parallel 3 ⇒ one bucket each ⇒ exactly 3 calls. An exact
			// count catches a regression that re-executes between buckets.
			expect(stub.executeCalls).toHaveLength(3);
			expect(stub.executeCalls.every((call) => call.placeVersion === undefined)).toBeTrue();
			expect(
				stub.executeCalls.every((call) => call.script.startsWith(guardPrefix(42))),
			).toBeTrue();
		});

		it("should run work-stealing tasks unpinned with the version guard", async () => {
			expect.assertions(3);

			const stub = createRunnerStub({
				uploadResult: { uploadMs: 12, versionNumber: 7 },
			});
			stub.setExecute(() => scriptResult(envelope([packageEntry("alpha")])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync({
				jobs: [job("alpha")],
				scriptOverride: "stealing-script",
				workStealing: true,
			});

			// work-stealing over 1 job with default parallel ⇒ exactly 1 task.
			expect(stub.executeCalls).toHaveLength(1);
			expect(stub.executeCalls[0]!.placeVersion).toBeUndefined();
			expect(withoutClaim(stub.executeCalls[0]!.script)).toBe(
				`${guardPrefix(7)}stealing-script`,
			);
		});

		/**
		 * An owned place omits the version guard only after a matching probe.
		 */
		it("should run unguarded and unpinned when the place is owned", async () => {
			expect.assertions(2);

			const stub = createRunnerStub({
				uploadResult: { uploadMs: 12, versionNumber: 7 },
			});
			stub.setExecute(() => scriptResult(envelope([packageEntry("alpha")])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync({
				jobs: [job("alpha", { ownedPlace: true })],
				scriptOverride: "stealing-script",
				workStealing: true,
			});

			expect(stub.executeCalls[0]!.placeVersion).toBeUndefined();
			expect(withoutClaim(stub.executeCalls[0]!.script)).toBe("stealing-script");
		});

		it("should inject the guard after leading Luau directives", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync({
				jobs: [job("alpha")],
				scriptOverride: "--!strict\n--!optimize 2\nreturn nil",
			});

			// Luau honors `--!` directives only in the leading comment block —
			// a plain line-1 prepend would silently disable them.
			expect(withoutClaim(stub.executeCalls[0]!.script)).toBe(
				`--!strict\n--!optimize 2\n${guardPrefix(1)}return nil`,
			);
		});

		it("should inject the guard behind a directive that follows a comment", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync({
				jobs: [job("alpha")],
				scriptOverride: "-- boot notes\n--!native\nreturn nil",
			});

			// The comment is no token, so the `--!native` behind it is still a
			// directive — and the guard ahead of it would end that.
			expect(withoutClaim(stub.executeCalls[0]!.script)).toBe(
				`-- boot notes\n--!native\n${guardPrefix(1)}return nil`,
			);
		});

		it("should inject the guard after a directive Luau does not act on", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync({
				jobs: [job("alpha")],
				scriptOverride: "--!Native\n--!strict\nreturn nil",
			});

			// `--!Native` is a hot comment Luau ignores, not the end of the
			// block, so the guard goes behind the `--!strict` it shields.
			expect(withoutClaim(stub.executeCalls[0]!.script)).toBe(
				`--!Native\n--!strict\n${guardPrefix(1)}return nil`,
			);
		});

		it("should retry a raced bucket once, pinned to the uploaded version", async () => {
			expect.assertions(5);

			const stub = createRunnerStub({
				uploadResult: { uploadMs: 12, versionNumber: 42 },
			});
			stub.setExecute(
				stepExecute([
					racedOnce,
					() => scriptResult(envelope([{ elapsedMs: 55, jestOutput: successJest() }])),
				]),
			);

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { rawResults } = await backend.runTestsAsync(jobsOptions([job("alpha")]));

			expect(stub.executeCalls).toHaveLength(2);

			const [raced, retried] = stub.executeCalls;

			expect(raced!.placeVersion).toBeUndefined();
			expect(retried!.placeVersion).toBe(42);
			// The pinned retry re-runs the original script, guard stripped — a
			// pinned task can't race, so the guard would only be dead weight.
			expect(`${guardPrefix(42)}${withoutClaim(retried!.script)}`).toBe(
				withoutClaim(raced!.script),
			);
			expect(rawResults[0]!.entry.elapsedMs).toBe(55);
		});

		it("should retry only the raced work-stealing task", async () => {
			expect.assertions(3);

			const stub = createRunnerStub({
				uploadResult: { uploadMs: 12, versionNumber: 9 },
			});
			stub.setExecute(
				stepExecute([
					racedOnce,
					() => scriptResult(envelope([packageEntry("alpha"), packageEntry("beta")])),
				]),
			);

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync({
				jobs: [job("alpha"), job("beta")],
				parallel: 2,
				scriptOverride: "stealing-script",
				workStealing: true,
			});

			// 2 tasks fired; the raced one retried pinned ⇒ exactly 3 calls, of
			// which exactly one is pinned.
			expect(stub.executeCalls).toHaveLength(3);
			expect(stub.executeCalls.filter((call) => call.placeVersion === 9)).toHaveLength(1);
			expect(stub.uploadCalls).toHaveLength(1);
		});

		it("should propagate upload errors from the runner", async () => {
			expect.assertions(1);

			const stub = createRunnerStub({
				uploadError: new Error("Failed to upload place: 401"),
			});
			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			await expect(backend.runTestsAsync(jobsOptions([job("alpha")]))).rejects.toThrow(
				/Failed to upload place/,
			);
		});

		it("should warn once on stderr when tasks race, even across multiple raced buckets", async () => {
			expect.assertions(2);

			const { restore, writes } = captureStderr();

			const stub = createRunnerStub();
			// Both buckets' unpinned first attempts race; the pinned retries
			// (recognizable by placeVersion) succeed.
			stub.setExecute(raceUnpinnedExecute(2));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync(jobsOptions([job("alpha"), job("beta")], 2));
			restore();

			const warnings = writes.filter((line) => line.includes("Tasks retried pinned"));

			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("raced by a concurrent upload");
		});

		it("should reset the one-shot race warning for each run", async () => {
			expect.assertions(1);

			const { restore, writes } = captureStderr();
			const stub = createRunnerStub({ uploadResult: { uploadMs: 3, versionNumber: 42 } });
			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			stub.setExecute(raceUnpinnedExecute(1));
			await backend.runTestsAsync(jobsOptions([job("alpha")]));
			stub.setExecute(raceUnpinnedExecute(1));
			await backend.runTestsAsync(jobsOptions([job("alpha")]));
			restore();

			expect(writes).toStrictEqual([
				"Warning: place version 42 raced by a concurrent upload — a task booted 99. Tasks retried pinned (slower, cold place boot).\n",
				"Warning: place version 42 raced by a concurrent upload — a task booted 99. Tasks retried pinned (slower, cold place boot).\n",
			]);
		});

		it("should not warn when no task races", async () => {
			expect.assertions(1);

			const { restore, writes } = captureStderr();

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync(jobsOptions([job("alpha")]));
			restore();

			expect(writes.filter((line) => line.includes("Tasks retried pinned"))).toHaveLength(0);
		});

		/**
		 * The guard reports which version the task actually booted, so the
		 * warning can name a cause instead of guessing one. A version ahead of
		 * this run's fresh upload is the genuine race: someone published
		 * between the upload and the boot.
		 */
		it("should name the version a concurrent upload booted", async () => {
			expect.assertions(1);

			const { restore, writes } = captureStderr();

			const stub = createRunnerStub({ uploadResult: { uploadMs: 3, versionNumber: 42 } });
			stub.setExecute(raceUnpinnedExecute(1));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync(jobsOptions([job("alpha")]));
			restore();

			expect(writes.join("")).toContain(
				"place version 42 raced by a concurrent upload — a task booted 99",
			);
		});

		/**
		 * A booted version *behind* the upload is the opposite problem:
		 * nothing raced, the save has yet to reach the boot pool.
		 */
		it("should report a version the boot pool has not picked up yet", async () => {
			expect.assertions(1);

			const { restore, writes } = captureStderr();

			const stub = createRunnerStub({ uploadResult: { uploadMs: 3, versionNumber: 42 } });
			stub.setExecute(raceUnpinnedExecute(1, 41));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync(jobsOptions([job("alpha")]));
			restore();

			expect(writes.join("")).toContain(
				"place version 42 is not in the boot pool yet — a task booted 41",
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
			const stub = createRunnerStub();
			stub.setExecute(
				stepExecute(
					taskPkgs.map((handledPkgs) => {
						return () => scriptResult(envelope(handledPkgs.map(packageEntry)));
					}),
				),
			);

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync({
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

			const guardedStealingScript = `${guardPrefix(1)}${stealingScript}`;

			expect(stub.executeCalls.map((call) => withoutClaim(call.script))).toStrictEqual([
				guardedStealingScript,
				guardedStealingScript,
				guardedStealingScript,
			]);
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

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync({
				jobs: [job("alpha"), job("beta")],
				parallel: 2,
				scriptOverride: "stealing-script",
				workStealing: true,
			});

			expect(stub.executeCalls).toHaveLength(2);
		});

		it("should shard a workspace run across one task per bucket", async () => {
			expect.assertions(2);

			// A workspace run knows every entry up front, so the factory can
			// carve them into one script per bucket. Without the queue that
			// is the only concurrency left, and multi mode already gets it.
			const stub = createRunnerStub();
			stub.setExecute(scriptedEntries);

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const results = await backend.runTestsAsync({
				jobs: [job("alpha"), job("beta"), job("gamma")],
				parallel: 3,
				scriptFactory: scriptNaming,
			});

			expect(results.rawResults).toHaveLength(3);
			expect(stub.executeCalls.map(requestedNames)).toStrictEqual([
				["alpha"],
				["beta"],
				["gamma"],
			]);
		});

		it("should re-send a deferring bucket's leftovers to that bucket alone", async () => {
			expect.assertions(2);

			// Each bucket owns its own deferral chain: the one that filled its
			// envelope re-sends only what it left behind, and its sibling is
			// untouched by the extra round.
			const stub = createRunnerStub();
			stub.setExecute(deferOnceExecute("alpha"));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const results = await backend.runTestsAsync({
				jobs: [job("alpha"), job("beta"), job("gamma"), job("delta")],
				parallel: 2,
				scriptFactory: scriptNaming,
			});

			expect(results.rawResults).toHaveLength(4);
			expect(stub.executeCalls.map(requestedNames)).toStrictEqual([
				["alpha", "gamma"],
				["beta", "delta"],
				["gamma"],
			]);
		});

		it("should keep a sibling bucket's results when one bucket bails", async () => {
			expect.assertions(2);

			// A bail is task-local on this path — there is no signal map to
			// broadcast it — so it stops the bucket that hit it and no other.
			// The sibling still runs its whole share, and the only jobs
			// reported skipped are the tail the bailing bucket never reached.
			const stub = createRunnerStub();
			stub.setExecute(bailingBucketExecute("alpha"));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const results = await backend.runTestsAsync({
				jobs: [job("alpha"), job("beta"), job("gamma"), job("delta")],
				parallel: 2,
				scriptFactory: scriptNaming,
			});

			// gamma alone: it shared alpha's bucket and never ran, while beta
			// and delta came back from the sibling that carried on.
			expect(results.bailedJobIndices).toStrictEqual([2]);
			expect(results.rawResults).toHaveLength(3);
		});

		it("should re-send the entries a deferring task left behind", async () => {
			expect.assertions(3);

			// A task that fills its envelope has no queue to leave the rest in
			// once work-stealing is out of reach. The backend has to rebuild a
			// script from what did not come back, or those packages are lost.
			const stub = createRunnerStub();
			stub.setExecute(
				stepExecute([
					() => scriptResult(envelope([packageEntry("alpha")], { deferred: true })),
					() => scriptResult(envelope([packageEntry("beta"), packageEntry("gamma")])),
				]),
			);

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const jobs = [job("alpha"), job("beta"), job("gamma")];
			const results = await backend.runTestsAsync({ jobs, scriptFactory: scriptNaming });

			expect(results.rawResults).toHaveLength(3);
			expect(stub.executeCalls).toHaveLength(2);
			// Only the two that did not come back the first time.
			expect(requestedNames(stub.executeCalls[1]!)).toStrictEqual(["beta", "gamma"]);
		});

		it("should stop after a non-deferred workspace envelope", async () => {
			expect.assertions(2);

			const stub = createRunnerStub();
			stub.setExecute(() => {
				return scriptResult(envelope([packageEntry("alpha"), packageEntry("beta")]));
			});
			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			const result = await backend.runTestsAsync({
				jobs: [job("alpha"), job("beta")],
				scriptFactory: () => "workspace-script",
			});

			expect(stub.executeCalls).toHaveLength(1);
			expect(result.rawResults).toHaveLength(2);
		});

		it("should stop when a deferred workspace envelope covered every job", async () => {
			expect.assertions(2);

			const stub = createRunnerStub();
			stub.setExecute(() => {
				return scriptResult(
					envelope([packageEntry("alpha"), packageEntry("beta")], { deferred: true }),
				);
			});
			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			const result = await backend.runTestsAsync({
				jobs: [job("alpha"), job("beta")],
				scriptFactory: () => "workspace-script",
			});

			expect(stub.executeCalls).toHaveLength(1);
			expect(result.rawResults).toHaveLength(2);
		});

		it("should preserve bail evidence across deferred workspace envelopes", async () => {
			expect.assertions(2);

			const stub = createRunnerStub();
			stub.setExecute(
				stepExecute([
					() => {
						return scriptResult(
							envelope([packageEntry("alpha")], { bailed: true, deferred: true }),
						);
					},
					() => scriptResult(envelope([packageEntry("beta")])),
				]),
			);
			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			const result = await backend.runTestsAsync({
				jobs: [job("alpha"), job("beta"), job("gamma")],
				scriptFactory: () => "workspace-script",
			});

			expect(stub.executeCalls).toHaveLength(2);
			expect(result.bailedJobIndices).toStrictEqual([2]);
		});

		it("should stop re-sending when a task covers nothing new", async () => {
			expect.assertions(2);

			// A task that defers without running anything cannot be answered by
			// sending it the same work again. Failing on the missing packages
			// beats spending one task per job to reach the same place.
			const stub = createRunnerStub();
			stub.setExecute(
				stepExecute([
					() => scriptResult(envelope([packageEntry("alpha")], { deferred: true })),
				]),
			);

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			await expect(
				backend.runTestsAsync({
					jobs: [job("alpha"), job("beta"), job("gamma")],
					scriptFactory: () => "retry-script",
				}),
			).rejects.toThrow("beta, gamma");

			expect(stub.executeCalls).toHaveLength(2);
		});

		it("should build the first script from the factory", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([packageEntry("alpha")])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync({
				jobs: [job("alpha")],
				scriptFactory: () => "factory-built",
			});

			expect(stub.executeCalls[0]!.script).toContain("factory-built");
		});

		it("should fail a workspace task that returns no output at all", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => ({ durationMs: 1, outputs: [] }));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			await expect(
				backend.runTestsAsync({
					jobs: [job("alpha")],
					scriptFactory: () => "factory-built",
				}),
			).rejects.toThrow("No test results in output");
		});

		it("should explain an oversized return that splitting cannot fix", async () => {
			expect.assertions(2);

			// Open Cloud names neither the cause nor a way out, and it rejects
			// the whole task — every package that task ran is lost with it. A
			// run reaching here is either single-task or has one package whose
			// own results exceed the cap, so the remedy has to be spelled out.
			const stub = createRunnerStub();
			const cause = new Error(
				"Return results too large. Please reduce return result length to 4194304. Current size: 5908004",
			);
			stub.setExecute(() => {
				throw cause;
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			const thrown = await backend
				.runTestsAsync({
					jobs: [job("alpha")],
					parallel: 2,
					scriptOverride: "stealing-script",
					workStealing: true,
				})
				.catch((err: unknown) => err);

			assert(thrown instanceof Error);

			expect(thrown.message).toBe(
				[
					cause.message,
					"One task returned more Jest output than Open Cloud accepts (4 MiB).",
					"Coverage is usually the bulk of it — try --no-coverage to confirm.",
					"Only files in the coverage universe are probed, so narrowing `collectCoverageFrom` to what you actually report on shrinks the payload with it.",
					'Otherwise set `parallel: "auto"` (or --parallel 2+) so results come back split across tasks, or narrow the run with --packages / --project.',
				].join("\n"),
			);
			expect(thrown.cause).toBe(cause);
		});

		it("should leave an unrelated task failure untouched", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => {
				throw new Error("open cloud task crashed");
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			await expect(
				backend.runTestsAsync({
					jobs: [job("alpha")],
					parallel: 2,
					scriptOverride: "stealing-script",
					workStealing: true,
				}),
			).rejects.toThrow("open cloud task crashed");
		});

		it("should launch a replacement task when a worker defers queued work", async () => {
			expect.assertions(2);

			// Open Cloud rejects a task returning over 4 MiB, so a worker whose
			// envelope fills up stops early and leaves the rest of the queue.
			// The deferral must earn exactly one replacement launch, or the
			// packages it left behind never come back.
			const stub = createRunnerStub();
			stub.setExecute(
				stepExecute([
					() => scriptResult(envelope([packageEntry("alpha")], { deferred: true })),
					() => scriptResult(envelope([packageEntry("beta")])),
					() => scriptResult(envelope([packageEntry("gamma")])),
				]),
			);

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const results = await backend.runTestsAsync({
				jobs: [job("alpha"), job("beta"), job("gamma")],
				parallel: 2,
				scriptOverride: "stealing-script",
				workStealing: true,
			});

			expect(stub.executeCalls).toHaveLength(3);
			expect(results.rawResults).toHaveLength(3);
		});

		it("should stop relaunching once every deferral has been answered", async () => {
			expect.assertions(1);

			// A replacement that drains the queue ends the chain. Without the
			// claim on launch, the same deferral could be answered twice and
			// the wave would keep firing tasks that have nothing left to do.
			const stub = createRunnerStub();
			stub.setExecute(
				stepExecute([
					() => scriptResult(envelope([packageEntry("alpha")], { deferred: true })),
					() => scriptResult(envelope([packageEntry("beta")])),
					() => scriptResult(envelope([packageEntry("gamma")])),
					() => scriptResult(envelope([])),
				]),
			);

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync({
				jobs: [job("alpha"), job("beta"), job("gamma")],
				parallel: 2,
				scriptOverride: "stealing-script",
				workStealing: true,
			});

			expect(stub.executeCalls).toHaveLength(3);
		});

		it("should bound the replacement chain when every task keeps deferring", async () => {
			expect.assertions(2);

			// A worker always takes at least one item, so a run can never need
			// more than one extra task per job. A producer that defers forever
			// must hit that bound and fail on the missing package rather than
			// launching tasks without end.
			const stub = createRunnerStub();
			stub.setExecute(
				stepExecute([
					() => scriptResult(envelope([packageEntry("alpha")], { deferred: true })),
				]),
			);

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			await expect(
				backend.runTestsAsync({
					jobs: [job("alpha"), job("beta")],
					parallel: 2,
					scriptOverride: "stealing-script",
					workStealing: true,
				}),
			).rejects.toThrow("beta");

			// parallel (2) + one launch per job (2).
			expect(stub.executeCalls).toHaveLength(4);
		});

		it("should fail the run when a task errors even if a sibling covers every package", async () => {
			expect.assertions(1);

			// The shared pool folds a task failure into a freed slot and
			// resolves, so without a post-pool guard an infrastructure/script
			// failure would be masked whenever a sibling task happens to drain
			// the whole queue and cover every package. The run must still fail.
			const stub = createRunnerStub();
			stub.setExecute(
				stepExecute([
					() => scriptResult(envelope([packageEntry("alpha"), packageEntry("beta")])),
					() => {
						throw new Error("open cloud task crashed");
					},
				]),
			);

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			await expect(
				backend.runTestsAsync({
					jobs: [job("alpha"), job("beta")],
					parallel: 2,
					scriptOverride: "stealing-script",
					workStealing: true,
				}),
			).rejects.toThrow(/open cloud task crashed/);
		});

		it("should drop duplicate-pkg entries from fault-recovery and keep the first occurrence", async () => {
			expect.assertions(2);

			const stub = createRunnerStub();
			stub.setExecute(
				stepExecute([
					() => {
						return scriptResult(
							envelope([
								{ elapsedMs: 1, jestOutput: successJest(), pkg: "alpha" },
								{ elapsedMs: 2, jestOutput: successJest(), pkg: "beta" },
							]),
						);
					},
					() => {
						return scriptResult(
							envelope([{ elapsedMs: 99, jestOutput: successJest(), pkg: "alpha" }]),
						);
					},
				]),
			);

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { rawResults } = await backend.runTestsAsync({
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
			stub.setExecute(() => {
				return scriptResult(envelope([{ jestOutput: successJest(), pkg: "alpha" }]));
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			await expect(
				backend.runTestsAsync({
					jobs: [job("alpha"), job("beta"), job("gamma")],
					parallel: 1,
					scriptOverride: "stealing-script",
					workStealing: true,
				}),
			).rejects.toThrow(/no entries for 2 package\(s\): beta, gamma/);
		});

		// --bail stops the run on the first failing package, so the packages
		// after it have no entry by design. Reporting them as bailed is what
		// separates that from a task that broke and lost its results.
		it("should report the jobs a bailed task never reached", async () => {
			expect.assertions(2);

			const stub = createRunnerStub();
			stub.setExecute(() => {
				return scriptResult(
					envelope([{ jestOutput: successJest(), pkg: "alpha" }], { bailed: true }),
				);
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { bailedJobIndices, rawResults } = await backend.runTestsAsync({
				jobs: [job("alpha"), job("beta"), job("gamma")],
				parallel: 1,
				scriptOverride: "stealing-script",
				workStealing: true,
			});

			expect(rawResults).toHaveLength(1);
			expect(bailedJobIndices).toStrictEqual([1, 2]);
		});

		it("should report no bailed jobs when a bailed task still covered them all", async () => {
			expect.assertions(2);

			const stub = createRunnerStub();
			stub.setExecute(() => {
				return scriptResult(
					envelope(
						[
							{ jestOutput: successJest(), pkg: "alpha" },
							{ jestOutput: successJest(), pkg: "beta" },
						],
						{ bailed: true },
					),
				);
			});

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { bailedJobIndices, rawResults } = await backend.runTestsAsync({
				jobs: [job("alpha"), job("beta")],
				parallel: 1,
				scriptOverride: "stealing-script",
				workStealing: true,
			});

			expect(rawResults).toHaveLength(2);
			expect(bailedJobIndices).toStrictEqual([]);
		});

		it("should preserve bail evidence when only one work-stealing task bails", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(
				stepExecute([
					() => scriptResult(envelope([packageEntry("alpha")], { bailed: true })),
					() => scriptResult(envelope([packageEntry("beta")])),
				]),
			);
			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			const result = await backend.runTestsAsync({
				jobs: [job("alpha"), job("beta"), job("gamma")],
				parallel: 2,
				scriptOverride: "stealing-script",
				workStealing: true,
			});

			expect(result.bailedJobIndices).toStrictEqual([2]);
		});

		it("should aggregate entries from all task envelopes in input order", async () => {
			expect.assertions(3);

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

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { rawResults } = await backend.runTestsAsync({
				jobs: [job("alpha"), job("beta"), job("gamma"), job("delta")],
				parallel: 2,
				scriptOverride: "stealing-script",
				workStealing: true,
			});

			// These results cross the backend boundary; pin every job/entry field
			// while retaining the readable ordering assertions below.
			expect(rawResults).toMatchSnapshot();

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
			const { rawResults } = await backend.runTestsAsync({
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
			const { rawResults } = await backend.runTestsAsync({
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
			await backend.runTestsAsync({
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

			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			onTestFinished(() => {
				vi.useRealTimers();
			});

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
			const promise = backend.runTestsAsync({
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
			await vi.runAllTimersAsync();
			await promise;

			expect(seen).toContain("alpha");
			expect(reader.deleted).toContain("alpha::alpha");
		});

		it("should emit a one-shot stderr warning when the streaming reader returns a PermissionError", async () => {
			expect.assertions(2);

			const { PermissionError } = await import("@bedrock-rbx/ocale");
			const { restore, writes } = captureStderr();

			const reader = {
				deleteAsync: async (): Promise<void> => {
					/* unused */
				},
				deleted: [],
				readAllAsync: async (): Promise<never> => {
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
			await backend.runTestsAsync({
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
			restore();

			const joined = writes.join("");

			expect(joined).toContain("memory-store.sorted-map:read");
			// Only one warning even though the failing read happens twice (poll
			// + final drain).
			expect(writes.filter((line) => line.includes("streaming disabled"))).toHaveLength(1);
		});

		it("should pluralize the scope hint when the PermissionError carries multiple scopes", async () => {
			expect.assertions(1);

			const { PermissionError } = await import("@bedrock-rbx/ocale");
			const { restore, writes } = captureStderr();

			const reader = {
				deleteAsync: async (): Promise<void> => {
					/* unused */
				},
				deleted: [],
				readAllAsync: async (): Promise<never> => {
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
			await backend.runTestsAsync({
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
			restore();

			expect(writes.join("")).toContain("missing scopes scope-a, scope-b");
		});

		it("should stringify a non-Error thrown by the streaming reader", async () => {
			expect.assertions(1);

			const { restore, writes } = captureStderr();

			const reader = {
				deleteAsync: async (): Promise<void> => {
					/* unused */
				},
				deleted: [],
				readAllAsync: async (): Promise<never> => {
					reader.readCalls += 1;

					// eslint-disable-next-line ts/only-throw-error -- exercising the non-Error branch in drainOnce's catch.
					throw "string-error";
				},
				readCalls: 0,
			};

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([packageEntry("alpha")])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync({
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
			restore();

			expect(writes.join("")).toContain("string-error");
		});

		it("should emit a one-shot stderr warning for non-permission streaming reader errors", async () => {
			expect.assertions(2);

			const { restore, writes } = captureStderr();

			const reader = {
				deleteAsync: async (): Promise<void> => {
					/* unused */
				},
				deleted: [],
				readAllAsync: async (): Promise<never> => {
					reader.readCalls += 1;
					throw new Error("network broke");
				},
				readCalls: 0,
			};

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([packageEntry("alpha")])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync({
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
			restore();

			expect(reader.readCalls).toBe(2);
			expect(writes).toStrictEqual([
				"Warning: live per-package streaming disabled — network broke\n",
				"  Tests still run; results print as usual once each task finishes.\n",
			]);
		});

		it("should swallow streaming reader errors so they don't fail the run", async () => {
			expect.assertions(1);

			const reader = {
				deleteAsync: async () => {
					/* unused */
				},
				deleted: [],
				readAllAsync: async () => {
					reader.readCalls += 1;
					throw new Error("read failed");
				},
				readCalls: 0,
			};

			const stub = createRunnerStub();
			stub.setExecute(() => scriptResult(envelope([packageEntry("alpha")])));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			const { rawResults } = await backend.runTestsAsync({
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
			expect.assertions(4);

			const seen: Array<string> = [];
			const { restore, writes } = captureStderr();
			let deletionCount = 0;
			const reader = {
				deleteAsync: async () => {
					deletionCount += 1;
					throw new Error("delete failed");
				},
				deleted: [],
				readAllAsync: async () => {
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
			const { rawResults } = await backend.runTestsAsync({
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
			restore();

			expect(seen).toContain("alpha");
			expect(rawResults).toHaveLength(1);
			expect(deletionCount).toBeGreaterThanOrEqual(1);
			expect(writes).toStrictEqual([
				"Warning: live per-package streaming disabled — delete failed\n",
				"  Tests still run; results print as usual once each task finishes.\n",
			]);
		});

		it("should throw when work-stealing executeScript returns no outputs", async () => {
			expect.assertions(1);

			const stub = createRunnerStub();
			stub.setExecute(() => ({ durationMs: 0, outputs: [] }));

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			await expect(
				backend.runTestsAsync({
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

	it("should run through the configured Open Cloud base URL", { timeout: 1000 }, async () => {
		expect.assertions(2);

		const server = await startFakeOpenCloudServerAsync([{ jestOutput: successJest() }]);
		const fetchAsync = globalThis.fetch;
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(localOnlyFetch(server.baseUrl, fetchAsync));
		onTestFinished(() => {
			fetch.mockRestore();
		});
		vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_BASE_URL", server.baseUrl);
		const rootDirectory = temporaryRoot();
		fs.writeFileSync(path.join(rootDirectory, "place.rbxlx"), '<roblox version="4"></roblox>');

		const backend = new OpenCloudBackend(credentials);
		const result = await backend.runTestsAsync({
			jobs: [cacheJob(rootDirectory, { bootProbeTimeout: 0, placeFile: "place.rbxlx" })],
		});

		expect(result.rawResults).toHaveLength(1);
		expect(server.calls).not.toBeEmpty();
	});

	it("should construct the default runner with JEST_ROBLOX_OCALE_MAX_RETRIES set", () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_OCALE_MAX_RETRIES", "8");

		const backend = new OpenCloudBackend(credentials);

		expect(backend).toBeInstanceOf(OpenCloudBackend);
	});
});

describe(resolveOpenCloudBaseUrl, () => {
	it("should return undefined when the env var is unset", () => {
		expect.assertions(1);

		expect(resolveOpenCloudBaseUrl()).toBeUndefined();
	});

	it.for([
		["", undefined],
		[" ".repeat(3), undefined],
		["///", ""],
		["https://apis.example.test", "https://apis.example.test"],
		["  https://apis.example.test/path///  ", "https://apis.example.test/path"],
	] as const)("should normalize %j to %j", ([raw, expected]) => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_BASE_URL", raw);

		expect(resolveOpenCloudBaseUrl()).toBe(expected);
	});
});

describe(resolveOcaleMaxRetries, () => {
	it("should return undefined when the env var is unset", () => {
		expect.assertions(1);

		expect(resolveOcaleMaxRetries()).toBeUndefined();
	});

	it("should return undefined for an empty/whitespace value", () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_OCALE_MAX_RETRIES", " ".repeat(3));

		expect(resolveOcaleMaxRetries()).toBeUndefined();
	});

	it("should parse a valid non-negative integer", () => {
		expect.assertions(2);

		vi.stubEnv("JEST_ROBLOX_OCALE_MAX_RETRIES", "8");

		expect(resolveOcaleMaxRetries()).toBe(8);

		vi.stubEnv("JEST_ROBLOX_OCALE_MAX_RETRIES", "0");

		expect(resolveOcaleMaxRetries()).toBe(0);
	});

	it("should return undefined for a partial-numeric value (parseInt trap)", () => {
		expect.assertions(1);

		// Number.parseInt("8abc") would truncate to 8; Number() rejects it.
		vi.stubEnv("JEST_ROBLOX_OCALE_MAX_RETRIES", "8abc");

		expect(resolveOcaleMaxRetries()).toBeUndefined();
	});

	it("should return undefined for a decimal value", () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_OCALE_MAX_RETRIES", "8.5");

		expect(resolveOcaleMaxRetries()).toBeUndefined();
	});

	it("should return undefined for a negative value", () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_OCALE_MAX_RETRIES", "-1");

		expect(resolveOcaleMaxRetries()).toBeUndefined();
	});
});

// Real tmpdir I/O per test (the cache reads place bytes off disk), so the
// suite-wide per-test budget cannot hold this describe under parallel load.
describe("upload cache", { timeout: 1000 }, () => {
	/**
	 * Run against a seeded cache with one task per entry in `bootedVersions`,
	 * each booting the version named instead of the reused one. Stderr is
	 * captured throughout, so a caller asserts on the warning, on the calls the
	 * runner saw, or on what a later {@link runOnceAsync} has to upload.
	 */
	async function raceCachedRunAsync(
		rootDirectory: string,
		bootedVersions: Array<number>,
	): Promise<{ capture: StderrCapture; stub: RunnerStub }> {
		const capture = captureStderr();
		const stub = createRunnerStub();
		stub.setExecute(raceBootedVersions(bootedVersions));

		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
		const jobs = bootedVersions.map(() => cacheJob(rootDirectory));
		await backend.runTestsAsync(jobsOptions(jobs, jobs.length));
		capture.restore();

		return { capture, stub };
	}

	/** How many uploads one passing run made. */
	async function runOnceAsync(
		rootDirectory: string,
		overrides: Partial<ResolvedConfig> = {},
	): Promise<number> {
		const { uploadCalls } = await runProbedRunAsync(rootDirectory, overrides);
		return uploadCalls.length;
	}

	function apiError(statusCode: number): Error {
		const cause = Object.assign(new Error(`HTTP ${String(statusCode)}`), { statusCode });
		return new Error("execute failed", { cause });
	}

	it("should upload on the first run and skip it on the second", async () => {
		expect.assertions(2);

		const rootDirectory = temporaryRoot();
		const first = await runOnceAsync(rootDirectory);
		const second = await runOnceAsync(rootDirectory);

		expect(first).toBe(1);
		expect(second).toBe(0);
	});

	it("should announce the cached version without opening an upload stage", async () => {
		expect.assertions(1);

		const rootDirectory = temporaryRoot();
		await runOnceAsync(rootDirectory);
		const stub = probeStub();
		const notes: Array<{ detail: string; id: StageId }> = [];
		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

		await backend.runTestsAsync({
			jobs: [cacheJob(rootDirectory)],
			progress: {
				...NOOP_RUN_PROGRESS,
				note: (id, detail) => {
					notes.push({ id, detail });
				},
			},
		});

		expect(notes).toStrictEqual([{ id: "upload", detail: "cache hit, version 42" }]);
	});

	it("should guard the reused version so a stale entry can only race", async () => {
		expect.assertions(1);

		const rootDirectory = temporaryRoot();
		await runOnceAsync(rootDirectory);

		const stub = createRunnerStub();
		stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));
		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
		await backend.runTestsAsync(jobsOptions([cacheJob(rootDirectory)]));

		expect(stub.executeCalls[0]!.script.startsWith(guardPrefix(42))).toBeTrue();
	});

	it("should retry pinned to the cached version when the guard races", async () => {
		expect.assertions(3);

		const rootDirectory = temporaryRoot();
		await runOnceAsync(rootDirectory);
		const { stub } = await raceCachedRunAsync(rootDirectory, [99]);

		// The whole safety argument for reusing a version: when another upload
		// moved the head, the raced task re-runs pinned to the version whose
		// bytes the cache hashed — never against whatever is live now.
		expect(stub.uploadCalls).toHaveLength(0);
		expect(stub.executeCalls[0]!.placeVersion).toBeUndefined();
		expect(stub.executeCalls[1]!.placeVersion).toBe(42);
	});

	/**
	 * A cached version is evicted only when the guard proves head moved ahead.
	 */
	it("should drop a cached version once the guard proves it is behind head", async () => {
		expect.assertions(1);

		const rootDirectory = temporaryRoot();
		await runOnceAsync(rootDirectory);
		await raceCachedRunAsync(rootDirectory, [99]);

		await expect(runOnceAsync(rootDirectory)).resolves.toBe(1);
	});

	/**
	 * Cache eviction still applies after the one-shot race warning is spent.
	 */
	it("should drop a stale cached version proved after the first warning", async () => {
		expect.assertions(3);

		const rootDirectory = temporaryRoot();
		await runOnceAsync(rootDirectory);
		const { capture } = await raceCachedRunAsync(rootDirectory, [41, 99]);
		const warnings = capture.writes.filter((line) => line.includes("Tasks retried pinned"));

		expect(warnings).toHaveLength(2);
		expect(warnings[1]).toContain("no longer head");
		await expect(runOnceAsync(rootDirectory)).resolves.toBe(1);
	});

	it("should say a cached version is no longer head only once", async () => {
		expect.assertions(1);

		const rootDirectory = temporaryRoot();
		await runOnceAsync(rootDirectory);
		const { capture } = await raceCachedRunAsync(rootDirectory, [99, 99]);

		expect(capture.writes.filter((line) => line.includes("no longer head"))).toHaveLength(1);
	});

	it("should say the cached version is no longer head", async () => {
		expect.assertions(1);

		const rootDirectory = temporaryRoot();
		await runOnceAsync(rootDirectory);
		const { capture } = await raceCachedRunAsync(rootDirectory, [99]);

		expect(capture.writes.join("")).toBe(
			"Warning: cached place version 42 is no longer head — a task booted 99. " +
				"Cache entry dropped, so the next run re-uploads. " +
				"Tasks retried pinned (slower, cold place boot).\n",
		);
	});

	/**
	 * A booted version behind the cached one says the boot pool lags, not that
	 * the entry is wrong. Dropping it there would trade a correct fast path for
	 * an upload on every run.
	 */
	it("should keep the cached version when the booted version is older", async () => {
		expect.assertions(1);

		const rootDirectory = temporaryRoot();
		await runOnceAsync(rootDirectory);
		await raceCachedRunAsync(rootDirectory, [41]);

		await expect(runOnceAsync(rootDirectory)).resolves.toBe(0);
	});

	it("should upload again when the place bytes change", async () => {
		expect.assertions(1);

		const rootDirectory = temporaryRoot();
		await runOnceAsync(rootDirectory);
		fs.writeFileSync(path.join(rootDirectory, "place.rbxl"), "different-bytes");
		const uploads = await runOnceAsync(rootDirectory);

		expect(uploads).toBe(1);
	});

	it("should always upload when the cache is disabled", async () => {
		expect.assertions(2);

		const rootDirectory = temporaryRoot();
		const first = await runOnceAsync(rootDirectory, { uploadCache: false });
		const second = await runOnceAsync(rootDirectory, { uploadCache: false });

		expect(first).toBe(1);
		expect(second).toBe(1);
	});

	it("should not write a cache file when the cache is disabled", async () => {
		expect.assertions(1);

		const rootDirectory = temporaryRoot();
		await runOnceAsync(rootDirectory, { uploadCache: false });

		expect(
			fs.existsSync(path.join(rootDirectory, ".jest-roblox", "upload-cache.json")),
		).toBeFalse();
	});

	it("should clear a suspect cache without restarting dispatched tests", async () => {
		expect.assertions(4);

		const rootDirectory = temporaryRoot();
		await runOnceAsync(rootDirectory);
		const capture = captureStderr();
		const failure = apiError(404);
		const stub = createRunnerStub();
		stub.setExecute(() => {
			throw failure;
		});
		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

		await expect(backend.runTestsAsync(jobsOptions([cacheJob(rootDirectory)]))).rejects.toBe(
			failure,
		);
		expect(stub.executeCalls).toHaveLength(1);
		expect(capture.writes.join("")).toContain(
			"clearing the upload cache without restarting dispatched tests",
		);
		await expect(runOnceAsync(rootDirectory)).resolves.toBe(1);
	});

	it("should not re-upload for a failure that is not a missing version", async () => {
		expect.assertions(3);

		const rootDirectory = temporaryRoot();
		await runOnceAsync(rootDirectory);

		const stub = createRunnerStub();
		stub.setExecute(() => {
			throw apiError(500);
		});

		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

		await expect(backend.runTestsAsync(jobsOptions([cacheJob(rootDirectory)]))).rejects.toThrow(
			"execute failed",
		);
		expect(stub.uploadCalls).toHaveLength(0);
		await expect(runOnceAsync(rootDirectory)).resolves.toBe(0);
	});

	it("should report cache lookup time separately from execution", async () => {
		expect.assertions(1);

		const rootDirectory = temporaryRoot();
		await runOnceAsync(rootDirectory);
		vi.spyOn(Date, "now")
			.mockReturnValueOnce(100)
			.mockReturnValueOnce(101)
			.mockReturnValueOnce(200)
			.mockReturnValueOnce(200)
			.mockReturnValue(222);
		const stub = createRunnerStub();
		stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));
		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
		const result = await backend.runTestsAsync(jobsOptions([cacheJob(rootDirectory)]));

		expect(result.timing).toStrictEqual({ executionMs: 22, uploadMs: 1 });
	});

	it("should not restart a cached run when a timeout recovery encounters a missing version", async () => {
		expect.assertions(2);

		const rootDirectory = temporaryRoot();
		await runOnceAsync(rootDirectory);
		const stub = createRunnerStub();
		stub.setExecute(
			vi
				.fn<ExecuteHandler>()
				.mockRejectedValueOnce(
					new PollTimeoutError("Still PROCESSING", { timeoutMs: 75_000 }),
				)
				.mockRejectedValueOnce(apiError(404))
				.mockReturnValue(scriptResult(envelope([{ jestOutput: successJest() }]))),
		);
		captureStderr();
		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

		await expect(backend.runTestsAsync(jobsOptions([cacheJob(rootDirectory)]))).rejects.toThrow(
			"Open Cloud recovery failed: PollTimeoutError: Still PROCESSING\nError: execute failed",
		);
		expect(stub.uploadCalls).toHaveLength(0);
	});
});

describe("boot probe", { timeout: 1000 }, () => {
	it("should not retry malformed results from a recovered pinned task", async () => {
		expect.assertions(2);

		const stub = probeStub();
		stub.setExecute(
			vi
				.fn<ExecuteHandler>()
				.mockReturnValueOnce(racedOnce())
				.mockRejectedValueOnce(probeTimeout())
				.mockReturnValueOnce(racedOnce())
				.mockReturnValue(scriptResult(envelope([{ jestOutput: successJest() }]))),
		);
		captureStderr();
		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

		await expect(backend.runTestsAsync(jobsOptions([job("alpha")]))).rejects.toBeInstanceOf(
			SyntaxError,
		);
		expect(stub.executeCalls).toHaveLength(3);
	});

	it("should retry a timed-out pinned task without returning to head", async () => {
		expect.assertions(2);

		const stub = probeStub();
		stub.setExecute(
			vi
				.fn<ExecuteHandler>()
				.mockReturnValueOnce(racedOnce())
				.mockRejectedValueOnce(probeTimeout())
				.mockReturnValue(scriptResult(envelope([{ jestOutput: successJest() }]))),
		);
		captureStderr();
		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
		await backend.runTestsAsync(jobsOptions([job("alpha")]));

		expect(stub.executeCalls.map((call) => call.placeVersion)).toStrictEqual([
			undefined,
			PROBED_VERSION,
			PROBED_VERSION,
		]);
		expect(stub.executeCalls[2]!.script).toBe(stub.executeCalls[1]!.script);
	});

	it("should preserve the claim when timeout recovery falls back to an exact version", async () => {
		expect.assertions(2);

		const stub = probeStub();
		stub.setExecute(
			vi
				.fn<ExecuteHandler>()
				.mockRejectedValueOnce(probeTimeout())
				.mockReturnValueOnce(racedOnce())
				.mockReturnValue(scriptResult(envelope([{ jestOutput: successJest() }]))),
		);
		captureStderr();
		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
		await backend.runTestsAsync(jobsOptions([job("alpha")]));
		const claims = stub.executeCalls.map((call) => claimParameters(call.script));

		expect(claims).toStrictEqual([claims[0]!, claims[0]!, claims[0]!]);
		expect(stub.executeCalls[2]!.placeVersion).toBe(PROBED_VERSION);
	});

	it("should recover when a test task stays PROCESSING after the probe passes", async () => {
		expect.assertions(3);

		const stub = probeStub();
		const execute = vi
			.fn<ExecuteHandler>()
			.mockRejectedValueOnce(probeTimeout())
			.mockReturnValue(scriptResult(envelope([{ jestOutput: successJest() }])));
		stub.setExecute(execute);
		captureStderr();
		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

		await backend.runTestsAsync(jobsOptions([job("alpha")]));

		expect(stub.executeCalls).toHaveLength(2);
		expect(stub.uploadCalls).toHaveLength(1);
		expect(stub.executeCalls[1]!.script).toBe(stub.executeCalls[0]!.script);
	});

	function headOnlyProbe(options: ExecuteScriptOptions): ScriptResult {
		if (options.placeVersion !== undefined) {
			throw probeTimeout();
		}

		return { durationMs: 0, outputs: [String(PROBED_VERSION)] };
	}

	it("should avoid a stuck pinned probe when head holds the uploaded version", async () => {
		expect.assertions(3);

		const stub = probeStub();
		stub.setProbe(headOnlyProbe);
		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

		await backend.runTestsAsync(jobsOptions([job("alpha")]));

		expect(stub.probeCalls).toHaveLength(1);
		expect(stub.executeCalls[0]!.bootProven).toBeTrue();
		expect(stub.executeCalls[0]!.script).toContain(
			placeIdentityGuardSource({ placeVersion: PROBED_VERSION }),
		);
	});

	it.for([["43"], []])(
		"should leave a shared version unverified when head returns %j",
		async (outputs) => {
			expect.assertions(4);

			const rootDirectory = temporaryRoot();
			const stub = probeStub();
			stub.setProbe(() => ({ durationMs: 0, outputs }));
			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

			await backend.runTestsAsync(jobsOptions([cacheJob(rootDirectory)]));
			const next = await runProbedRunAsync(rootDirectory);

			expect(stub.probeCalls).toHaveLength(1);
			expect(stub.executeCalls[0]!.bootProven).toBeFalse();
			expect(stub.executeCalls[0]!.script).toContain(
				placeIdentityGuardSource({ placeVersion: PROBED_VERSION }),
			);
			expect(next.uploadCalls).toHaveLength(1);
		},
	);

	it("should run guarded tests after an inconclusive probe timeout", async () => {
		expect.assertions(3);

		const stub = probeStub();
		stub.setProbe(() => {
			throw probeTimeout();
		});
		const capture = captureStderr();
		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

		await backend.runTestsAsync(jobsOptions([job("alpha")]));
		capture.restore();

		expect(stub.executeCalls[0]!.bootProven).toBeFalse();
		expect(stub.executeCalls[0]!.script).toContain(
			placeIdentityGuardSource({ placeVersion: PROBED_VERSION }),
		);
		expect(capture.writes.join("")).toBe(
			"Warning: boot probe for place version 42 is inconclusive after 90s; continuing with guarded tests.\n" +
				"  Open Cloud may have stalled the probe; this does not prove the place cannot load.\n",
		);
	});

	it.for([
		{ detail: undefined, outputs: ["42"] },
		{ detail: "inconclusive", outputs: ["43"] },
	])("should report the probe outcome %j", async ({ detail, outputs }) => {
		expect.assertions(1);

		const stub = probeStub();
		stub.setProbe(() => ({ durationMs: 0, outputs }));
		const completed: Array<{ detail: string | undefined; id: StageId }> = [];
		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

		await backend.runTestsAsync({
			jobs: [job("alpha")],
			progress: {
				...NOOP_RUN_PROGRESS,
				begin: (id) => (result) => {
					completed.push({ id, detail: result });
				},
			},
		});

		expect(completed).toContainEqual({ id: "boot", detail });
	});

	/** What the runner throws when a task never reaches a terminal state. */
	function probeTimeout(): Error {
		return new Error("Execution timed out: Roblox never reported a terminal state", {
			cause: new PollTimeoutError("poll budget exhausted", { timeoutMs: 135_000 }),
		});
	}

	it.for([false, true])(
		"should probe a fresh upload on head with ownedPlace=%s",
		async (ownedPlace) => {
			expect.assertions(3);

			const stub = probeStub();

			const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
			await backend.runTestsAsync(jobsOptions([job("alpha", { ownedPlace })]));

			expect(stub.probeCalls).toHaveLength(1);
			expect(stub.probeCalls[0]!.script).toBe(BOOT_PROBE_SCRIPT);
			expect(stub.probeCalls[0]!.placeVersion).toBeUndefined();
		},
	);

	it("should warn and leave a shared upload uncached when the probe reads a foreign head", async () => {
		expect.assertions(3);

		const stub = probeStub();
		stub.setProbe(() => ({ durationMs: 0, outputs: ["43"] }));
		const capture = captureStderr();
		const rootDirectory = temporaryRoot();
		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
		await backend.runTestsAsync(jobsOptions([cacheJob(rootDirectory)]));
		const second = await runProbedRunAsync(rootDirectory);

		expect(capture.writes.join("")).toBe(
			"Warning: boot probe read head version 43, but this run uploaded 42.\n  Continuing with guarded tests; the unverified upload is not cached.\n",
		);
		expect(stub.executeCalls[0]!.bootProven).toBeFalse();
		expect(second.probeCalls).toHaveLength(1);
	});

	/** An owned place with a mismatched probe still needs its version guard. */
	it("should keep the guard and skip the cache when an owned head is not ours", async () => {
		expect.assertions(4);

		const stub = probeStub();
		stub.setProbe(() => ({ durationMs: 0, outputs: [String(PROBED_VERSION + 1)] }));
		const capture = captureStderr();

		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
		const rootDirectory = temporaryRoot();
		await backend.runTestsAsync(jobsOptions([cacheJob(rootDirectory, { ownedPlace: true })]));

		capture.restore();

		expect(stub.executeCalls[0]!.script).toContain(
			placeIdentityGuardSource({ placeVersion: PROBED_VERSION }),
		);
		expect(stub.executeCalls[0]!.bootProven).toBeFalse();
		expect(capture.writes.join("")).toBe(
			"Warning: ownedPlace was set, but head is 43 rather than the uploaded version 42 — " +
				"another run wrote this place.\n" +
				"  Falling back to the version guard for this run; check the lease that set the flag.\n",
		);

		// A second run must upload again: nothing was cached, because the bytes
		// this run uploaded are not the bytes that booted.
		const second = await runProbedRunAsync(rootDirectory, { ownedPlace: true });

		expect(second.probeCalls).toHaveLength(1);
	});

	/**
	 * A probe that prints nothing leaves the claim unproven, which is not the
	 * same as disproven — but it is just as far from the fact the fast path
	 * needs, so it is treated the same way.
	 */
	it("should keep the guard when an owned probe reports no version", async () => {
		expect.assertions(3);

		const stub = probeStub();
		stub.setProbe(() => ({ durationMs: 0, outputs: [] }));
		const capture = captureStderr();

		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
		await backend.runTestsAsync(jobsOptions([job("alpha", { ownedPlace: true })]));
		capture.restore();

		expect(stub.executeCalls[0]!.script).toContain(
			placeIdentityGuardSource({ placeVersion: PROBED_VERSION }),
		);
		expect(stub.executeCalls[0]!.bootProven).toBeFalse();
		expect(capture.writes.join("")).toBe(
			"Warning: ownedPlace was set, but head is unreadable rather than the uploaded version 42 — " +
				"another run wrote this place.\n" +
				"  Falling back to the version guard for this run; check the lease that set the flag.\n",
		);
	});

	/**
	 * Ownership says no other run writes this place *now*; it says nothing
	 * about who wrote it before this run held the lease. A cached version is a
	 * claim about the past, so head may hold a previous holder's bytes — the
	 * one case where dropping the guard would run the tests against code from
	 * another checkout and report a pass. Only a version this run uploaded is
	 * head by construction.
	 */
	it("should keep the guard on an owned place when the version came from cache", async () => {
		expect.assertions(2);

		const rootDirectory = temporaryRoot();
		const first = await runProbedRunAsync(rootDirectory, { ownedPlace: true });
		const second = await runProbedRunAsync(rootDirectory, { ownedPlace: true });

		// Version-agnostic: a guard pinned to any other version is still a
		// guard, and this asserts there is none.
		expect(first.executeCalls[0]!.script).not.toContain(PLACE_MISMATCH);
		expect(second.executeCalls[0]!.script).toContain(
			placeIdentityGuardSource({ placeVersion: PROBED_VERSION }),
		);
	});

	/**
	 * The cache entry is written only once the probe passes, so a hit already
	 * carries the proof. Re-probing would spend a boot on a question already
	 * answered, on every run that reuses a version.
	 */
	it("should skip the probe when the version came from the upload cache", async () => {
		expect.assertions(2);

		const rootDirectory = temporaryRoot();
		const first = await runProbedRunAsync(rootDirectory);
		const second = await runProbedRunAsync(rootDirectory);

		expect(first.probeCalls).toHaveLength(1);
		expect(second.probeCalls).toHaveLength(0);
	});

	/**
	 * Zero is the off switch, for a suite that has proved the probe elsewhere
	 * and would rather spend the boot on tests. The version then earns no cache
	 * entry: an entry means "these bytes boot", and nothing proved it.
	 */
	it("should skip the probe, and cache nothing, when the budget is zero", async () => {
		expect.assertions(4);

		const rootDirectory = temporaryRoot();
		const first = await runProbedRunAsync(rootDirectory, { bootProbeTimeout: 0 });
		const second = await runProbedRunAsync(rootDirectory, { bootProbeTimeout: 0 });

		expect(first.probeCalls).toHaveLength(0);
		expect(second.probeCalls).toHaveLength(0);
		expect(second.uploadCalls).toHaveLength(1);
		expect(second.executeCalls[0]!.bootProven).toBeFalse();
	});

	/**
	 * The runner falls back to naming a place Roblox cannot load when a task
	 * never settles. The probe has just disproved that for these bytes, so a
	 * later timeout must not send the reader to Studio over it.
	 */
	it("should tell the runner the place boots once the probe has passed", async () => {
		expect.assertions(2);

		const stub = probeStub();

		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
		await backend.runTestsAsync(jobsOptions([job("alpha")]));

		expect(stub.executeCalls).toHaveLength(1);
		expect(stub.executeCalls[0]!.bootProven).toBeTrue();
	});

	/**
	 * A cache entry says the bytes booted when it was written, which is not
	 * the same claim, so a reused version leaves the runner its own reading.
	 */
	it("should leave the runner to guess when the version came from the cache", async () => {
		expect.assertions(1);

		const rootDirectory = temporaryRoot();
		await runProbedRunAsync(rootDirectory);
		const second = await runProbedRunAsync(rootDirectory);

		expect(second.executeCalls[0]!.bootProven).toBeFalse();
	});

	it("should propagate a test timeout after an inconclusive probe", async () => {
		expect.assertions(2);

		const stub = probeStub();
		stub.setProbe(() => {
			throw probeTimeout();
		});
		const testFailure = probeTimeout();
		stub.setExecute(() => {
			throw testFailure;
		});
		captureStderr();

		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
		const caught = await backend
			.runTestsAsync(jobsOptions([job("alpha")]))
			.catch((err: unknown) => err);

		expect(caught).toHaveProperty("cause", testFailure);
		expect(stub.executeCalls).toHaveLength(2);
	});

	/** An inconclusive probe cannot verify a version for later runs. */
	it("should not cache a version whose probe never completed", async () => {
		expect.assertions(2);

		const rootDirectory = temporaryRoot();
		const failing = probeStub();
		failing.setProbe(() => {
			throw probeTimeout();
		});

		const backend = new OpenCloudBackend(credentials, { runner: failing.runner });

		captureStderr();
		await backend.runTestsAsync(jobsOptions([cacheJob(rootDirectory)]));

		const next = await runProbedRunAsync(rootDirectory);

		expect(next.uploadCalls).toHaveLength(1);
		expect(next.probeCalls).toHaveLength(1);
	});

	/**
	 * The probe body cannot fail on its own, but the call still rides the same
	 * API as everything else. A throttle or a bad key says something about the
	 * request, not about the place, and must not be reported as one.
	 */
	it("should pass a probe failure that is not a timeout through untouched", async () => {
		expect.assertions(1);

		const stub = probeStub();
		stub.setProbe(() => {
			throw new Error("HTTP 429: Too Many Requests");
		});

		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });

		await expect(backend.runTestsAsync(jobsOptions([job("alpha")]))).rejects.toThrow(
			"HTTP 429: Too Many Requests",
		);
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

		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
		await backend.runTestsAsync(jobsOptions([job("alpha")]));

		expect(stub.probeCalls[0]!.pollBudget).toBe(90_000);
		expect(stub.probeCalls[0]!.timeout).toBeLessThan(90_000);
		expect(stub.executeCalls[0]!.timeout).toBe(DEFAULT_CONFIG.timeout);
	});

	it("should honour a bootProbeTimeout override", async () => {
		expect.assertions(1);

		const stub = createRunnerStub();
		stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
		await backend.runTestsAsync(jobsOptions([job("alpha", { bootProbeTimeout: 30_000 })]));

		expect(stub.probeCalls[0]!.pollBudget).toBe(30_000);
	});

	/**
	 * A budget under the probe's own deadline is still the whole answer: the
	 * task may not be given longer to run than the caller will wait for it.
	 */
	it("should never give the probe a deadline past its budget", async () => {
		expect.assertions(2);

		const stub = createRunnerStub();
		stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));

		const backend = new OpenCloudBackend(credentials, { runner: stub.runner });
		await backend.runTestsAsync(jobsOptions([job("alpha", { bootProbeTimeout: 1000 })]));

		expect(stub.probeCalls[0]!.pollBudget).toBe(1000);
		expect(stub.probeCalls[0]!.timeout).toBe(1000);
	});
});

const BUNDLE_FILE = "/cache/code-bundle.json";
const BUNDLE_JSON = '{"mounts":[],"version":1}';
const REFRESHED_PATH = "universes/123/luau-execution-session-task-binary-inputs/input-2";
const REFRESH_STEP_MS = 14 * 60_000;

/**
 * A Code Bundle is the run's compiled code, taken out of the place and sent as
 * a binary input instead. Every assertion here is about what reached the wire:
 * the input the create returned, the script each submit carried, and the
 * number of creates a run made.
 */
describe("code bundle", () => {
	function bundleArtifact(overrides: Partial<CodeBundleArtifact> = {}): CodeBundleArtifact {
		return {
			byteLength: BUNDLE_JSON.length,
			fileCount: 3,
			path: BUNDLE_FILE,
			stayedMounts: [],
			...overrides,
		};
	}

	/** A backend reading its bundle out of a volume of this test's own. */
	function bundleBackend(stub: RunnerStub, now?: () => number): OpenCloudBackend {
		const { fileSystem } = createMemoryFileSystem({ [BUNDLE_FILE]: BUNDLE_JSON });
		return new OpenCloudBackend(credentials, { fileSystem, now, runner: stub.runner });
	}

	/** A stub whose every task passes, whatever script it was handed. */
	function passingStub(stubOptions: RunnerStubOptions = {}): RunnerStub {
		const stub = createRunnerStub(stubOptions);
		stub.setExecute(() => scriptResult(envelope([{ jestOutput: successJest() }])));
		return stub;
	}

	/** One passing run that ships a bundle, returning the stub it drove. */
	async function runBundledAsync(options: Partial<BackendOptions> = {}): Promise<RunnerStub> {
		const stub = passingStub();
		await bundleBackend(stub).runTestsAsync({
			codeBundle: bundleArtifact(),
			jobs: [job("alpha")],
			...options,
		});
		return stub;
	}

	it("should upload the bundle once and name the input on the submit", async () => {
		expect.assertions(3);

		const stub = await runBundledAsync();

		expect(stub.binaryInputCalls).toHaveLength(1);
		expect(Buffer.from(stub.binaryInputCalls[0]!.payload).toString("utf-8")).toBe(BUNDLE_JSON);
		expect(stub.executeCalls[0]!.binaryInput).toBe(DEFAULT_BINARY_INPUT_PATH);
	});

	it("should upload the bundle once for a run that shards", async () => {
		expect.assertions(2);

		const stub = await runBundledAsync({
			jobs: [job("alpha"), job("beta"), job("gamma")],
			parallel: 3,
		});

		expect(stub.executeCalls).toHaveLength(3);
		expect(stub.binaryInputCalls).toHaveLength(1);
	});

	it("should put the rebuild below the version guard", async () => {
		expect.assertions(3);

		const stub = await runBundledAsync();
		const { script } = stub.executeCalls[0]!;
		const guard = placeIdentityGuardSource({ placeVersion: 1 });

		expect(script).toContain(CODE_BUNDLE_REBUILD_SOURCE);
		expect(script.indexOf(guard)).toBeLessThan(script.indexOf(CODE_BUNDLE_REBUILD_SOURCE));
		// Behind the directives either way — a preamble above them would turn
		// every `--!` line the script wrote into an ordinary comment.
		expect(script.startsWith(guard)).toBeTrue();
	});

	/**
	 * The workspace materializer clones each package's stage into its live
	 * services, so a stage rebuilt after that clone would ship the previous
	 * run's code. The rebuild leads the whole script, which is what makes the
	 * ordering hold for any script a caller hands over rather than this one.
	 */
	it("should put the rebuild above the script it was handed", async () => {
		expect.assertions(2);

		const stub = await runBundledAsync({ scriptOverride: "--!strict\nmaterialize()" });
		const { script } = stub.executeCalls[0]!;

		expect(script.startsWith("--!strict\n")).toBeTrue();
		expect(script.indexOf(CODE_BUNDLE_REBUILD_SOURCE)).toBeLessThan(
			script.indexOf("materialize()"),
		);
	});

	it("should carry the rebuild and the input on the pinned retry", async () => {
		expect.assertions(4);

		const stub = createRunnerStub();
		stub.setExecute(raceUnpinnedExecute(1));
		const capture = captureStderr();
		onTestFinished(capture.restore);
		await bundleBackend(stub).runTestsAsync({
			codeBundle: bundleArtifact(),
			jobs: [job("alpha")],
		});

		const retry = stub.executeCalls[1]!;

		expect(retry.placeVersion).toBe(1);
		expect(retry.binaryInput).toBe(DEFAULT_BINARY_INPUT_PATH);
		expect(retry.script).toContain(CODE_BUNDLE_REBUILD_SOURCE);
		// The guard is what a pinned submit drops; the rebuild is not.
		expect(retry.script).not.toContain(PLACE_MISMATCH);
	});

	it("should carry the rebuild with no guard on an owned place", async () => {
		expect.assertions(3);

		const stub = await runBundledAsync({ jobs: [job("alpha", { ownedPlace: true })] });
		const { script } = stub.executeCalls[0]!;

		expect(stub.executeCalls[0]!.binaryInput).toBe(DEFAULT_BINARY_INPUT_PATH);
		expect(withoutClaim(script).startsWith(CODE_BUNDLE_REBUILD_SOURCE)).toBeTrue();
		expect(script).not.toContain(PLACE_MISMATCH);
	});

	it("should neither upload nor rebuild without a bundle", async () => {
		expect.assertions(3);

		const stub = passingStub();
		await bundleBackend(stub).runTestsAsync({ jobs: [job("alpha")] });

		expect(stub.binaryInputCalls).toHaveLength(0);
		expect(stub.executeCalls[0]!.binaryInput).toBeUndefined();
		expect(stub.executeCalls[0]!.script).not.toContain(CODE_BUNDLE_REBUILD_SOURCE);
	});

	/**
	 * The composed script is cached on the caller's script and the guard it
	 * carries, which are run-constant. A second run on the same instance sends
	 * the same two and can be shipping its code the other way, so a cache that
	 * outlived its run would hand it a script rebuilding from an input nothing
	 * created — and the task would fail on its first line.
	 */
	it("should compose a second run's script without the first run's cache", async () => {
		expect.assertions(2);

		const stub = passingStub();
		const { fileSystem } = createMemoryFileSystem({ [BUNDLE_FILE]: BUNDLE_JSON });
		const backend = new OpenCloudBackend(credentials, { fileSystem, runner: stub.runner });

		await backend.runTestsAsync({ codeBundle: bundleArtifact(), jobs: [job("alpha")] });
		await backend.runTestsAsync({ jobs: [job("alpha")] });

		expect(stub.executeCalls[0]!.script).toContain(CODE_BUNDLE_REBUILD_SOURCE);
		expect(stub.executeCalls[1]!.script).not.toContain(CODE_BUNDLE_REBUILD_SOURCE);
	});

	/**
	 * A pinned retry must refresh a binary input that expired after the head
	 * attempt.
	 */
	async function runAcrossElapsedAsync(elapseMs: number): Promise<RunnerStub> {
		const stub = createRunnerStub({
			binaryInputPaths: [DEFAULT_BINARY_INPUT_PATH, REFRESHED_PATH],
		});
		let now = 0;
		stub.setExecute((executeOptions) => {
			now += elapseMs;
			return executeOptions.placeVersion === undefined ? racedOnce() : oneSuccessEntry();
		});
		const capture = captureStderr();
		onTestFinished(capture.restore);
		await bundleBackend(stub, () => now).runTestsAsync({
			codeBundle: bundleArtifact(),
			jobs: [job("alpha")],
		});
		return stub;
	}

	it("should create the input again once it is too old for the next submit", async () => {
		expect.assertions(3);

		const stub = await runAcrossElapsedAsync(REFRESH_STEP_MS);

		expect(stub.binaryInputCalls).toHaveLength(2);
		expect(stub.executeCalls[0]!.binaryInput).toBe(DEFAULT_BINARY_INPUT_PATH);
		expect(stub.executeCalls[1]!.binaryInput).toBe(REFRESHED_PATH);
	});

	it("should create the input again at the refresh threshold itself", async () => {
		expect.assertions(1);

		// The threshold is the margin, not the expiry: an input reaching it is
		// one whose next submit could be read after Open Cloud's fifteen
		// minutes are up.
		const stub = await runAcrossElapsedAsync(13 * 60_000);

		expect(stub.binaryInputCalls).toHaveLength(2);
	});

	it("should keep an input the refresh threshold has not reached", async () => {
		expect.assertions(2);

		const stub = await runAcrossElapsedAsync(60_000);

		expect(stub.binaryInputCalls).toHaveLength(1);
		expect(stub.executeCalls[1]!.binaryInput).toBe(DEFAULT_BINARY_INPUT_PATH);
	});

	it("should charge the bundle's create and PUT to uploadMs", async () => {
		expect.assertions(2);

		const stub = passingStub({ binaryInputUploadMs: 4321 });
		let now = 10_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		stub.setExecute(() => {
			now = 20_000;
			return oneSuccessEntry();
		});

		const result = await bundleBackend(stub).runTestsAsync({
			codeBundle: bundleArtifact(),
			jobs: [job("alpha")],
		});

		// The runner's own figure, not a second measurement around it: it spans
		// the create — the pacer's wait for the per-key quota included — and the
		// PUT, which is the whole of what the bundle cost.
		expect(result.timing.uploadMs).toBeGreaterThanOrEqual(4321);
		expect(result.timing.executionMs).toBe(5679);
	});

	it("should announce the bundle stage with its size and file count", async () => {
		expect.assertions(3);

		const opened: Array<{ detail: string | undefined; id: StageId }> = [];
		const closed: Array<{ detail: string | undefined; id: StageId }> = [];
		const stub = passingStub();
		await bundleBackend(stub).runTestsAsync({
			codeBundle: bundleArtifact(),
			jobs: [job("alpha")],
			progress: {
				...NOOP_RUN_PROGRESS,
				begin: (id, detail) => {
					opened.push({ id, detail });
					return (closingDetail) => {
						closed.push({ id, detail: closingDetail });
					};
				},
			},
		});

		expect(opened).toContainEqual({ id: "bundle", detail: "25 B, 3 files" });
		expect(opened).toContainEqual({ id: "boot", detail: "version 1" });
		expect(closed).toStrictEqual([
			{ id: "upload", detail: "version 1" },
			{ id: "boot", detail: undefined },
			{ id: "bundle", detail: undefined },
			{ id: "tests", detail: undefined },
		]);
	});

	it("should name the mounts that stayed once, on stderr", async () => {
		expect.assertions(1);

		const capture = captureStderr();
		onTestFinished(capture.restore);
		const stub = passingStub();
		await bundleBackend(stub).runTestsAsync({
			codeBundle: bundleArtifact({
				stayedMounts: [
					"ServerStorage/__pkg_stage/pkg/assets",
					"ReplicatedStorage/__pkg_stage/shared/config",
				],
			}),
			jobs: [job("alpha")],
		});

		expect(capture.writes).toStrictEqual([
			"Note: 2 code mount(s) stayed in the place, each holding a file a task cannot rebuild:\n" +
				"  ServerStorage/__pkg_stage/pkg/assets\n" +
				"  ReplicatedStorage/__pkg_stage/shared/config\n",
		]);
	});

	it("should say nothing when every code mount travels", async () => {
		expect.assertions(1);

		const capture = captureStderr();
		onTestFinished(capture.restore);
		await runBundledAsync();

		expect(capture.writes.filter((line) => line.includes("code mount"))).toHaveLength(0);
	});

	/**
	 * Every submit of a sharded run crosses the refresh threshold at the same
	 * moment, so without a hold on the upload in flight each one fires its own
	 * create — N against a five-a-minute quota, N PUTs of the same bytes.
	 */
	it("should make one create for concurrent submits that all want a fresh input", async () => {
		expect.assertions(2);

		const stub = passingStub({
			binaryInputPaths: [DEFAULT_BINARY_INPUT_PATH, REFRESHED_PATH],
		});
		// The run's first upload happens before any task dispatches and dates
		// its input at zero; every reading after that is past the refresh
		// threshold, so both shards want a new input at once.
		let clock = 0;
		function now(): number {
			const reading = clock;
			clock = REFRESH_STEP_MS;
			return reading;
		}

		await bundleBackend(stub, now).runTestsAsync({
			codeBundle: bundleArtifact(),
			jobs: [job("alpha"), job("beta")],
			parallel: 2,
		});

		// One refresh behind the first upload rather than one per shard.
		expect(stub.binaryInputCalls).toHaveLength(2);
		expect(stub.executeCalls.map((call) => call.binaryInput)).toStrictEqual([
			REFRESHED_PATH,
			REFRESHED_PATH,
		]);
	});

	it("should fail a create the client cannot complete, naming the quota and the flag", async () => {
		expect.assertions(2);

		const stub = passingStub({
			binaryInputError: new Error("Failed to allocate a binary input slot: 429"),
		});

		const failure = await bundleBackend(stub)
			.runTestsAsync({ codeBundle: bundleArtifact(), jobs: [job("alpha")] })
			.catch((err: unknown) => err);
		assert(failure instanceof ConfigError, "expected a ConfigError");

		expect(failure.message).toContain("Failed to allocate a binary input slot: 429");
		// The quota is the cause a reader can act on — several agents on one
		// key — and the flag is the way out. Asserted whole rather than by
		// keyword: each clause is one of the three things a reader needs, and
		// a hint that lost one still contains the others.
		expect(failure.hint).toBe(
			"`binaryInputs.create` is metered at five a minute per API key, and the " +
				"client has already retried inside that budget — so several runs " +
				"sharing one key is the usual cause.\n" +
				"Run with `--no-binary-input` to upload the code inside the place instead.",
		);
	});
});
