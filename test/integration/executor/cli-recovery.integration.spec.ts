import { OcaleRunner } from "@isentinel/roblox-runner";
import type { ExecuteScriptOptions } from "@isentinel/roblox-runner";

import path from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { OpenCloudBackend } from "../../../src/backends/open-cloud.ts";
import { runAsync } from "../../../src/cli.ts";
import { loadConfig } from "../../../src/config/loader.ts";
import { EXECUTION_NOT_CLAIMED } from "../../../src/luau/execution-claim.ts";
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
