import { PollTimeoutError } from "@bedrock-rbx/ocale";
import type { ExecuteScriptOptions, RemoteRunner, ScriptResult } from "@isentinel/roblox-runner";

import * as path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { NOOP_PROGRESS } from "#test/mocks/noop-progress.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { captureStderrForTest as captureStderr } from "#test/mocks/spec-open-cloud.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { RunProgress } from "../progress/run-progress.ts";
import type { StageId } from "../progress/stages.ts";
import { PlaceVersionGate, toCacheTarget, type UploadOutcome } from "./open-cloud-place-version.ts";

const VERSION = 42;

type ProbeHandler = (options: ExecuteScriptOptions) => ScriptResult;

function pollTimeout(): Error {
	return new Error("Execution timed out: Roblox never reported a terminal state", {
		cause: new PollTimeoutError("poll budget exhausted", { timeoutMs: 135_000 }),
	});
}

function passingProbe(): ScriptResult {
	return { durationMs: 0, outputs: [String(VERSION)] };
}

function setup() {
	const rootDirectory = path.resolve("upload-cache");
	const placeFilePath = path.join(rootDirectory, "place.rbxl");
	const { fileSystem } = createMemoryFileSystem({ [placeFilePath]: "place-bytes" });
	const target = toCacheTarget(
		{ apiKey: "key", placeId: "456", universeId: "123" },
		placeFilePath,
	);
	let probe: ProbeHandler = passingProbe;
	const executeScriptAsync = vi.fn<(options: ExecuteScriptOptions) => Promise<ScriptResult>>(
		async (options) => probe(options),
	);
	const uploadPlaceAsync = vi.fn<RemoteRunner["uploadPlaceAsync"]>(async () => {
		return {
			uploadMs: 12,
			versionNumber: VERSION,
		};
	});
	const gate = new PlaceVersionGate({
		fileSystem,
		runner: { executeScriptAsync, uploadPlaceAsync },
	});

	function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
		return { ...createResolvedConfig(), rootDir: rootDirectory, ...overrides };
	}

	/**
	 * Upload or reuse, then prove the version boots, as one run does.
	 * @param options - Config overrides and progress sink.
	 * @returns The upload outcome and whether the boot was proven.
	 */
	async function runAsync({
		overrides,
		progress = NOOP_PROGRESS,
	}: { overrides?: Partial<ResolvedConfig>; progress?: RunProgress } = {}) {
		const resolved = config(overrides);
		const upload = await gate.uploadOrReuseAsync({ config: resolved, progress, target });
		const isBootProven = await gate.verifyBootAsync({
			config: resolved,
			progress,
			target,
			upload,
		});
		return { isBootProven, upload };
	}

	return {
		executeScriptAsync,
		fileSystem,
		gate,
		placeFilePath,
		rootDirectory,
		runAsync,
		setProbe: (handler: ProbeHandler) => {
			probe = handler;
		},
		target,
		uploadPlaceAsync,
	};
}

describe(PlaceVersionGate, () => {
	describe("upload cache", () => {
		it("should upload on the first run and reuse the version on the second", async () => {
			expect.assertions(3);

			const { runAsync, uploadPlaceAsync } = setup();

			await runAsync();
			const second = await runAsync();

			expect(uploadPlaceAsync).toHaveBeenCalledOnce();
			expect(second.upload).toMatchObject({ fromCache: true, versionNumber: VERSION });
			expect(second.isBootProven).toBeFalse();
		});

		it("should announce the cached version without opening an upload stage", async () => {
			expect.assertions(1);

			const { runAsync } = setup();
			await runAsync();
			const notes: Array<{ detail: string; id: StageId }> = [];

			await runAsync({
				progress: {
					...NOOP_PROGRESS,
					note: (id, detail) => {
						notes.push({ id, detail });
					},
				},
			});

			expect(notes).toStrictEqual([{ id: "upload", detail: "cache hit, version 42" }]);
		});

		it("should upload again when the place bytes change", async () => {
			expect.assertions(1);

			const { fileSystem, placeFilePath, runAsync, uploadPlaceAsync } = setup();
			await runAsync();
			fileSystem.writeFileSync(placeFilePath, "different-bytes");
			await runAsync();

			expect(uploadPlaceAsync).toHaveBeenCalledTimes(2);
		});

		it("should always upload, and write no cache file, when the cache is disabled", async () => {
			expect.assertions(2);

			const { fileSystem, rootDirectory, runAsync, uploadPlaceAsync } = setup();

			await runAsync({ overrides: { uploadCache: false } });
			await runAsync({ overrides: { uploadCache: false } });

			expect(uploadPlaceAsync).toHaveBeenCalledTimes(2);
			expect(
				fileSystem.existsSync(
					path.join(rootDirectory, ".jest-roblox", "upload-cache.json"),
				),
			).toBeFalse();
		});
	});

	describe("boot probe", () => {
		it("should prove the uploaded version with a probe pinned to it", async () => {
			expect.assertions(2);

			const { executeScriptAsync, runAsync } = setup();

			await expect(runAsync()).resolves.toHaveProperty("isBootProven", true);
			expect(executeScriptAsync.mock.calls.map(([options]) => options)).toStrictEqual([
				{
					placeVersion: VERSION,
					pollBudget: 90_000,
					script: "return tostring(game.PlaceVersion)",
					timeout: 10_000,
				},
			]);
		});

		it.for([
			{ message: 'reported "43"', outputs: ["43"] },
			{ message: 'reported ""', outputs: [] },
		])(
			"should stop when the probe reports $outputs and cache nothing",
			async ({ message, outputs }) => {
				expect.assertions(3);

				const { executeScriptAsync, runAsync, setProbe, uploadPlaceAsync } = setup();
				setProbe(() => ({ durationMs: 0, outputs }));

				const caught = await runAsync().catch((err: unknown) => err);
				setProbe(passingProbe);
				await runAsync();

				assert(caught instanceof Error);

				expect(caught).toHaveProperty("message", expect.stringContaining(message));
				// A completed probe has answered; asking again cannot change it.
				expect(executeScriptAsync).toHaveBeenCalledTimes(2);
				expect(uploadPlaceAsync).toHaveBeenCalledTimes(2);
			},
		);

		/** A lost probe says nothing about the place. */
		it("should send one more probe when the first is lost", async () => {
			expect.assertions(2);

			const { executeScriptAsync, runAsync, setProbe } = setup();
			setProbe(() => {
				setProbe(passingProbe);
				throw pollTimeout();
			});

			await expect(runAsync()).resolves.toHaveProperty("isBootProven", true);
			expect(executeScriptAsync).toHaveBeenCalledTimes(2);
		});

		it("should stop as boot unverified, sending no third probe, when both are lost", async () => {
			expect.assertions(3);

			const { executeScriptAsync, runAsync, setProbe, uploadPlaceAsync } = setup();
			setProbe(() => {
				throw pollTimeout();
			});

			await expect(runAsync()).rejects.toThrow(
				"Place version 42 is boot unverified: no boot probe completed within 90s. No tests were submitted.",
			);
			expect(executeScriptAsync).toHaveBeenCalledTimes(2);

			setProbe(passingProbe);
			await runAsync();

			expect(uploadPlaceAsync).toHaveBeenCalledTimes(2);
		});

		it("should name the probe budget in whole seconds", async () => {
			expect.assertions(1);

			const { runAsync, setProbe } = setup();
			setProbe(() => {
				throw pollTimeout();
			});

			await expect(runAsync({ overrides: { bootProbeTimeout: 29_600 } })).rejects.toThrow(
				"no boot probe completed within 30s.",
			);
		});

		it("should close the boot stage once the probe passes", async () => {
			expect.assertions(1);

			const completed: Array<{
				begun: string | undefined;
				detail: string | undefined;
				id: StageId;
			}> = [];
			const { runAsync } = setup();

			await runAsync({
				progress: {
					...NOOP_PROGRESS,
					begin: (id, begun) => (result) => {
						completed.push({ id, begun, detail: result });
					},
				},
			});

			expect(completed).toStrictEqual([
				{ id: "upload", begun: "11 B", detail: "version 42" },
				{ id: "boot", begun: "version 42", detail: undefined },
			]);
		});

		/**
		 * Zero is the off switch. The version then earns no cache entry: an
		 * entry means "these bytes boot", and nothing proved it.
		 */
		it("should skip the probe, and cache nothing, when the budget is zero", async () => {
			expect.assertions(3);

			const { executeScriptAsync, runAsync, uploadPlaceAsync } = setup();

			const first = await runAsync({ overrides: { bootProbeTimeout: 0 } });
			await runAsync({ overrides: { bootProbeTimeout: 0 } });

			expect(first.isBootProven).toBeFalse();
			expect(executeScriptAsync).not.toHaveBeenCalled();
			expect(uploadPlaceAsync).toHaveBeenCalledTimes(2);
		});

		/**
		 * A throttle or a bad key says something about the request, not about
		 * the place, and must not be reported as one.
		 */
		it("should pass a probe failure that is not a timeout through untouched", async () => {
			expect.assertions(1);

			const { runAsync, setProbe } = setup();
			setProbe(() => {
				throw new Error("HTTP 429: Too Many Requests");
			});

			await expect(runAsync()).rejects.toThrow("HTTP 429: Too Many Requests");
		});

		it.for([
			{ budget: 30_000, timeout: 10_000 },
			{ budget: 1000, timeout: 1000 },
		])(
			"should give a $budget ms probe budget a $timeout ms deadline",
			async ({ budget, timeout }) => {
				expect.assertions(1);

				const { executeScriptAsync, runAsync } = setup();
				await runAsync({ overrides: { bootProbeTimeout: budget } });

				expect(executeScriptAsync.mock.calls[0]![0]).toMatchObject({
					pollBudget: budget,
					timeout,
				});
			},
		);
	});

	describe("executeWithCachedUploadAsync", () => {
		function apiError(statusCode: number): Error {
			const cause = Object.assign(new Error(`HTTP ${String(statusCode)}`), { statusCode });
			return new Error("execute failed", { cause });
		}

		async function failCachedAsync(failure: Error) {
			const context = setup();
			const { gate, rootDirectory, runAsync, target } = context;
			await runAsync();
			const { upload } = await runAsync();
			const caught = await gate
				.executeWithCachedUploadAsync({ rootDirectory, target, upload }, async () => {
					throw failure;
				})
				.catch((err: unknown) => err);
			await runAsync();
			return { ...context, caught };
		}

		it("should hand back what the attempt produced", async () => {
			expect.assertions(1);

			const { gate, rootDirectory, target } = setup();
			const upload: UploadOutcome = {
				fromCache: true,
				hash: undefined,
				uploadMs: 0,
				versionNumber: VERSION,
			};

			await expect(
				gate.executeWithCachedUploadAsync(
					{ rootDirectory, target, upload },
					async () => "ok",
				),
			).resolves.toBe("ok");
		});

		it("should clear a suspect cache entry on a 404 and rethrow", async () => {
			expect.assertions(3);

			const writes = captureStderr();
			const failure = apiError(404);
			const { caught, uploadPlaceAsync } = await failCachedAsync(failure);

			expect(caught).toBe(failure);
			expect(writes.join("")).toContain(
				"clearing the upload cache without restarting dispatched tests",
			);
			expect(uploadPlaceAsync).toHaveBeenCalledTimes(2);
		});

		it("should keep the cache entry for a failure that is not a missing version", async () => {
			expect.assertions(2);

			const failure = apiError(500);
			const { caught, uploadPlaceAsync } = await failCachedAsync(failure);

			expect(caught).toBe(failure);
			expect(uploadPlaceAsync).toHaveBeenCalledOnce();
		});
	});
});
