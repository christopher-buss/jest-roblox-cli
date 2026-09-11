import { OcaleRunner } from "@isentinel/roblox-runner";
import type { ExecuteScriptOptions } from "@isentinel/roblox-runner";

import path from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import { assert, describe, expect, it, vi } from "vitest";

import { OpenCloudBackend } from "../../../src/backends/open-cloud.ts";
import { runAsync } from "../../../src/cli.ts";
import { loadConfig } from "../../../src/config/loader.ts";
import {
	EXECUTION_NOT_CLAIMED,
	ExecutionClaimObserver,
} from "../../../src/luau/execution-claim.ts";
import { runJestRobloxAsync } from "../../../src/run.ts";
import { nodeRunSeams } from "../../../src/run/seams.ts";
import { startFakeOpenCloudServerAsync } from "../../e2e/cli/fake-open-cloud.ts";
import {
	buildMixedOutput,
	buildPassingPayload,
	createFixtureSandbox,
} from "../../e2e/cli/helpers.ts";

const FIXTURE = path.resolve(import.meta.dirname, "../../e2e/fixtures/luau-project");
const JEST_OUTPUT = buildMixedOutput(buildPassingPayload());

describe("cLI Open Cloud recovery", () => {
	it("should replace a stalled task when its boot claim is still missing", async () => {
		expect.assertions(5);

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const sandbox = createFixtureSandbox(FIXTURE);
		const server = await startFakeOpenCloudServerAsync(
			[
				{ jestOutput: JEST_OUTPUT, pollsBeforeComplete: Number.MAX_SAFE_INTEGER },
				{ jestOutput: JEST_OUTPUT },
			],
			{ executionClaim: "missing" },
		);
		const credentials = { apiKey: "fake", placeId: "456", universeId: "123" };
		const runner = new OcaleRunner(credentials, { baseUrl: server.baseUrl, maxRetries: 0 });
		let firstSubmittedAt: number | undefined;
		let replacementSubmittedAt: number | undefined;
		const executeScriptAsync = vi
			.fn<(options: ExecuteScriptOptions) => ReturnType<OcaleRunner["executeScriptAsync"]>>()
			.mockImplementationOnce(async (options) => {
				firstSubmittedAt = performance.now();
				return runner.executeScriptAsync({ ...options, pollBudget: 200 });
			})
			.mockImplementation(async (options) => {
				replacementSubmittedAt = performance.now();
				return runner.executeScriptAsync(options);
			});
		const backend = new OpenCloudBackend(credentials, {
			bootWatchMs: 5,
			executionClaimObserver: new ExecutionClaimObserver({
				baseUrl: server.baseUrl,
				credentials,
			}),
			runner: {
				executeScriptAsync,
				uploadBinaryInputAsync: async (options) => runner.uploadBinaryInputAsync(options),
				uploadPlaceAsync: async (options) => runner.uploadPlaceAsync(options),
			},
		});
		const seams = { ...nodeRunSeams(), resolveBackend: async () => backend };
		const actual = await runAsync([], {
			loadConfig: async () => {
				return {
					...(await loadConfig(undefined, sandbox)),
					bootProbeTimeout: 0,
					uploadCache: false,
				};
			},
			runJestRoblox: async (...args) => {
				return runJestRobloxAsync(args[0], args[1], args[2], { ...args[3], seams });
			},
		});

		expect(actual).toBe(0);

		assert(firstSubmittedAt !== undefined, "expected the original task to be submitted");
		assert(
			replacementSubmittedAt !== undefined,
			"expected the replacement task to be submitted",
		);

		expect(replacementSubmittedAt - firstSubmittedAt).toBeLessThan(150);
		expect({
			requestCount: server.requests.length,
			sameClaim: server.requests[1]!.script === server.requests[0]!.script,
		}).toStrictEqual({ requestCount: 2, sameClaim: true });
		expect(server.calls).toContainEqual(
			expect.objectContaining({
				method: "GET",
				url: expect.stringContaining(
					"/memory-store/sorted-maps/jest-roblox-execution-v1/items/",
				),
			}),
		);
		expect({
			executeCount: executeScriptAsync.mock.calls.length,
			warning: stderr.mock.calls.map(([chunk]) => String(chunk)).join(""),
		}).toStrictEqual({
			executeCount: 2,
			warning: expect.stringContaining("did not claim execution within"),
		});
	});

	it.for([
		{
			exitCode: 0,
			outcome: "replacement",
			pollsBeforeComplete: Number.MAX_SAFE_INTEGER,
			replacement: { jestOutput: JEST_OUTPUT },
		},
		{
			exitCode: 0,
			outcome: "original",
			pollsBeforeComplete: 0,
			replacement: { rawOutput: EXECUTION_NOT_CLAIMED },
		},
		{
			exitCode: 2,
			outcome: "missing",
			pollsBeforeComplete: Number.MAX_SAFE_INTEGER,
			replacement: { rawOutput: EXECUTION_NOT_CLAIMED },
		},
	])(
		"should report $outcome results after the original observer times out",
		async ({ exitCode, pollsBeforeComplete, replacement }) => {
			expect.assertions(5);

			const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			const sandbox = createFixtureSandbox(FIXTURE);
			const server = await startFakeOpenCloudServerAsync([
				{
					jestOutput: JEST_OUTPUT,
					pollsBeforeComplete,
				},
				replacement,
			]);
			const credentials = { apiKey: "fake", placeId: "456", universeId: "123" };
			const runner = new OcaleRunner(credentials, { baseUrl: server.baseUrl, maxRetries: 0 });
			const executeScriptAsync = vi
				.fn<
					(options: ExecuteScriptOptions) => ReturnType<OcaleRunner["executeScriptAsync"]>
				>()
				.mockImplementationOnce(async (options) => {
					return runner.executeScriptAsync({ ...options, pollBudget: 0 });
				})
				.mockImplementation(async (options) => runner.executeScriptAsync(options));
			const backend = new OpenCloudBackend(credentials, {
				runner: {
					executeScriptAsync,
					uploadBinaryInputAsync: async (options) => {
						return runner.uploadBinaryInputAsync(options);
					},
					uploadPlaceAsync: async (options) => runner.uploadPlaceAsync(options),
				},
			});
			const seams = { ...nodeRunSeams(), resolveBackend: async () => backend };

			const actual = await runAsync([], {
				loadConfig: async () => {
					return {
						...(await loadConfig(undefined, sandbox)),
						bootProbeTimeout: 0,
						uploadCache: false,
					};
				},
				runJestRoblox: async (...args) => {
					return runJestRobloxAsync(args[0], args[1], args[2], { ...args[3], seams });
				},
			});

			const output = stripVTControlCharacters(
				[
					...stdout.mock.calls.map(([chunk]) => String(chunk)),
					...log.mock.calls.map((args) => args.map(String).join(" ")),
				].join(""),
			);

			expect(actual).toBe(exitCode);
			expect(output.includes("1 passed")).toBe(exitCode === 0);
			expect(server.requests[1]!.script).toBe(server.requests[0]!.script);
			expect(server.requests).toHaveLength(2);
			expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
				"retrying once with the same execution claim",
			);
		},
	);
});
