import { OcaleRunner } from "@isentinel/roblox-runner";
import type { ExecuteScriptOptions } from "@isentinel/roblox-runner";

import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import { assert, describe, expect, it, vi } from "vitest";

import { loadConfig, OpenCloudBackend, runProjectsAsync } from "#src/index.ts";
import { startFakeOpenCloudServerAsync } from "#test/e2e/cli/fake-open-cloud.ts";
import {
	buildMixedOutput,
	buildPassingPayload,
	createFixtureSandbox,
	writeCodeBundle,
} from "#test/e2e/cli/helpers.ts";
import { IS_BINARY_INPUT } from "#test/e2e/live/live-gate.ts";
import { EXECUTION_NOT_CLAIMED } from "#test/mocks/luau-execution-claim.ts";

type ClaimObserver = NonNullable<
	NonNullable<ConstructorParameters<typeof OpenCloudBackend>[1]>["executionClaimObserver"]
>;

const FIXTURE = path.resolve(import.meta.dirname, "../../e2e/fixtures/luau-project");
const JEST_OUTPUT = buildMixedOutput(buildPassingPayload());

/**
 * Run the fixture on one backend with a Code Bundle beside the place: the one
 * run that may replace a task.
 * @param backend - Open Cloud backend to run on.
 * @param sandbox - Fixture copy to run.
 * @returns Exit code and formatted output, or exit code 2 when the run throws.
 */
async function runRecoveryAsync(
	backend: OpenCloudBackend,
	sandbox: string,
): Promise<{ exitCode: number; output: string }> {
	writeFileSync(path.join(sandbox, "place.rbxlx"), '<roblox version="4"></roblox>');
	const config = {
		...(await loadConfig({ cwd: sandbox })),
		bootProbeTimeout: 0,
		placeFile: "place.rbxlx",
		uploadCache: false,
	};
	try {
		const { results } = await runProjectsAsync({
			backend,
			codeBundle: writeCodeBundle(sandbox),
			projects: [{ config, testFiles: ["src/example.spec.luau"] }],
			startTime: Date.now(),
			version: "0.0.0-test",
		});
		return { exitCode: results[0]!.exitCode, output: results[0]!.output };
	} catch {
		return { exitCode: 2, output: "" };
	}
}

function silenceCliOutput() {
	vi.spyOn(process.stdout, "write").mockReturnValue(true);
	vi.spyOn(console, "log").mockImplementation(() => {});
	return vi.spyOn(process.stderr, "write").mockReturnValue(true);
}

function claimParameters(script: string): string {
	const match = /local key, startBefore, retention, notClaimed, startExpired = [^\r\n]+/u.exec(
		script,
	);
	assert(match !== null, "submitted script must contain an execution claim");
	return match[0];
}

describe.skipIf(!IS_BINARY_INPUT)("cLI Open Cloud recovery", () => {
	it("should recover a task create failure with a fresh relay and the same claim", async () => {
		expect.assertions(4);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const sandbox = createFixtureSandbox(FIXTURE);
		const server = await startFakeOpenCloudServerAsync([{ jestOutput: JEST_OUTPUT }], {
			submitFailures: [
				{ body: { code: "INTERNAL", message: "unknown exception" }, status: 500 },
			],
		});
		const credentials = { apiKey: "fake", placeId: "456", universeId: "123" };
		vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_BASE_URL", server.baseUrl);
		const backend = new OpenCloudBackend(credentials, {
			runner: new OcaleRunner(credentials, { baseUrl: server.baseUrl, maxRetries: 0 }),
		});
		const { exitCode: actual } = await runRecoveryAsync(backend, sandbox);

		expect(actual).toBe(0);
		expect(server.requests).toHaveLength(2);

		const [first, replacement] = server.requests;
		assert(first !== undefined && replacement !== undefined);

		expect(claimParameters(replacement.script)).toBe(claimParameters(first.script));

		const firstRelay = /local attempt = "([^"]+)"/u.exec(first.script);
		const replacementRelay = /local attempt = "([^"]+)"/u.exec(replacement.script);
		assert(firstRelay !== null && replacementRelay !== null);

		expect(replacementRelay[1]).not.toBe(firstRelay[1]);
	});

	it("should replace a stalled task when its boot claim is still missing", async () => {
		expect.assertions(5);

		const stderr = silenceCliOutput();
		const sandbox = createFixtureSandbox(FIXTURE);
		const server = await startFakeOpenCloudServerAsync(
			[
				{ jestOutput: JEST_OUTPUT, pollsBeforeComplete: Number.MAX_SAFE_INTEGER },
				{ jestOutput: JEST_OUTPUT },
			],
			{ executionClaim: "missing" },
		);
		const credentials = { apiKey: "fake", placeId: "456", universeId: "123" };
		vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_BASE_URL", server.baseUrl);
		const runner = new OcaleRunner(credentials, { baseUrl: server.baseUrl, maxRetries: 0 });
		const readClaimAsync = vi.fn<ClaimObserver["readAsync"]>(async () => {
			return { status: "missing" };
		});
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
			executionClaimObserver: { readAsync: readClaimAsync },
			runner: {
				executeScriptAsync,
				uploadBinaryInputAsync: async (options) => runner.uploadBinaryInputAsync(options),
				uploadPlaceAsync: async (options) => runner.uploadPlaceAsync(options),
			},
		});
		const { exitCode: actual } = await runRecoveryAsync(backend, sandbox);

		expect(actual).toBe(0);

		assert(firstSubmittedAt !== undefined, "expected the original task to be submitted");
		assert(
			replacementSubmittedAt !== undefined,
			"expected the replacement task to be submitted",
		);

		expect(replacementSubmittedAt - firstSubmittedAt).toBeLessThan(150);
		expect({
			requestCount: server.requests.length,
			sameClaim:
				claimParameters(server.requests[1]!.script) ===
				claimParameters(server.requests[0]!.script),
		}).toStrictEqual({ requestCount: 2, sameClaim: true });
		expect(readClaimAsync).toHaveBeenCalledWith(expect.any(String), expect.any(AbortSignal));
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

			let clock = 1_000_000;
			vi.spyOn(Date, "now").mockImplementation(() => clock);
			const stderr = silenceCliOutput();
			const sandbox = createFixtureSandbox(FIXTURE);
			const server = await startFakeOpenCloudServerAsync([
				{
					jestOutput: JEST_OUTPUT,
					pollsBeforeComplete,
				},
				replacement,
			]);
			const credentials = { apiKey: "fake", placeId: "456", universeId: "123" };
			vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_BASE_URL", server.baseUrl);
			const runner = new OcaleRunner(credentials, {
				baseUrl: server.baseUrl,
				maxRetries: 0,
				sleep: async (ms) => {
					clock += ms;
				},
			});
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

			const { exitCode: actual, output: runOutput } = await runRecoveryAsync(
				backend,
				sandbox,
			);

			const output = stripVTControlCharacters(runOutput);

			expect(actual).toBe(exitCode);
			expect(output.includes("1 passed")).toBe(exitCode === 0);
			expect(claimParameters(server.requests[1]!.script)).toBe(
				claimParameters(server.requests[0]!.script),
			);
			expect(server.requests).toHaveLength(2);
			expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
				"retrying once with the same execution claim",
			);
		},
	);
});
