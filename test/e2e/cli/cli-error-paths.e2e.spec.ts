import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assert, describe, expect, it } from "vitest";

import { startFakeOpenCloudServerAsync } from "./fake-open-cloud.ts";
import type { JestEnvelopePayload } from "./helpers.ts";
import {
	buildMixedOutput,
	buildPassingPayload,
	createFixtureSandbox,
	createOpenCloudEnvironment,
	createRbxtsFixtureSandbox,
	runCliAsync,
} from "./helpers.ts";

const LUAU_FIXTURE = path.resolve(__dirname, "../fixtures/luau-project");
const RBXTS_FIXTURE = path.resolve(__dirname, "../fixtures/rbxts-project");

/**
 * Shorten the boot probe's budget for a sandbox, so a spec that stalls the
 * probe on purpose costs seconds rather than the 90s a real cold boot is
 * allowed. Patches the fixture's own config rather than restating it, so the
 * sandbox keeps testing the same project shape as every sibling spec.
 */
function writeBootProbeTimeout(sandbox: string, bootProbeTimeout: number): void {
	const configPath = path.join(sandbox, "jest.config.ts");
	const source = readFileSync(configPath, "utf-8");
	const patched = source.replace(
		"defineConfig({",
		() => `defineConfig({
	bootProbeTimeout: ${String(bootProbeTimeout)},`,
	);
	// A patch that matched nothing would leave the 90s default in place and the
	// spec would fail as a long, unexplained wait rather than a broken helper.
	assert(patched !== source, "boot-probe patch matched nothing in the fixture config");
	writeFileSync(configPath, patched);
}

describe("cli error paths", () => {
	describe("exit codes", () => {
		it("should exit 1 when the Jest payload reports failed tests", async () => {
			expect.assertions(2);

			const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
			const server = await startFakeOpenCloudServerAsync([
				{
					jestOutput: buildMixedOutput(buildFailingPayload()),
				},
			]);

			const result = await runCliAsync([], {
				cwd: sandbox,
				env: createOpenCloudEnvironment(server.baseUrl),
			});

			// Exit 1 is the test-failure signal — distinct from exit 2 which
			// the CLI uses for argv/config errors.
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("1 failed");
		});

		it("should exit non-zero with an env-var hint when --backend open-cloud is missing credentials", async () => {
			expect.assertions(3);

			const sandbox = createFixtureSandbox(RBXTS_FIXTURE);

			const result = await runCliAsync(["--backend", "open-cloud"], {
				cwd: sandbox,
				env: {
					// Strip every Open Cloud env var so the resolver has no
					// fallback source.
					JEST_ROBLOX_OPEN_CLOUD_API_KEY: undefined,
					JEST_ROBLOX_PLACE_ID: undefined,
					JEST_ROBLOX_UNIVERSE_ID: undefined,
					ROBLOX_OPEN_CLOUD_API_KEY: undefined,
					ROBLOX_PLACE_ID: undefined,
					ROBLOX_UNIVERSE_ID: undefined,
				},
			});

			expect(result.exitCode).toBeGreaterThan(0);
			expect(result.stderr).toContain("Missing: apiKey, universeId, placeId");
			expect(result.stderr).toContain(
				"Set ROBLOX_OPEN_CLOUD_API_KEY (or JEST_ROBLOX_OPEN_CLOUD_API_KEY)",
			);
		});

		// A poll that never settles used to be tested here too, at 48s of real
		// wall-clock: the runner keeps polling for a fixed 45s boot-lag grace
		// after the task deadline, and the grace does not scale with
		// `--timeout`. It bought nothing that was not already covered twice
		// over. `libs/roblox-runner/src/ocale-runner.spec.ts` asserts the whole
		// message — task path, `last observed state: PROCESSING`, the
		// deadline-plus-allowance phrasing — under fake timers, instantly. And
		// every backend error reaches the same `printError` + exit 2 boundary in
		// `cli.ts`, which the task-failure case below already drives in about a
		// second.

		it("should exit non-zero naming a place version Open Cloud cannot start", async () => {
			expect.assertions(4);

			// A place version Roblox cannot boot leaves every task PROCESSING
			// with no error and no log, so the probe timing out is the only
			// signal there is. Nothing may be dispatched against it.
			const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
			writeBootProbeTimeout(sandbox, 2000);
			const server = await startFakeOpenCloudServerAsync(
				[{ jestOutput: buildMixedOutput(buildPassingPayload()) }],
				{ bootProbe: "stall" },
			);

			const result = await runCliAsync([], {
				cwd: sandbox,
				env: createOpenCloudEnvironment(server.baseUrl),
			});

			expect(result.exitCode).toBeGreaterThan(0);
			expect(result.stderr).toContain("Place version 1 cannot be started by Open Cloud.");
			expect(result.stderr).toContain("A trivial script against it also never ran (2s).");
			expect(server.requests).toHaveLength(0);
		});

		it("should surface the Roblox error code and log tail when a task fails", async () => {
			expect.assertions(3);

			const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
			const server = await startFakeOpenCloudServerAsync([
				{
					errorMessage: "TaskScript:1: attempt to index nil",
					logs: [
						{ message: "loading test bundle", messageType: "OUTPUT" },
						{
							message: "TaskScript:1: attempt to index nil",
							messageType: "ERROR",
						},
					],
					state: "FAILED",
				},
			]);

			const result = await runCliAsync([], {
				cwd: sandbox,
				env: createOpenCloudEnvironment(server.baseUrl),
			});

			expect(result.exitCode).toBeGreaterThan(0);
			expect(result.stderr).toContain("Roblox task failed (SCRIPT_ERROR)");
			expect(result.stderr).toContain("[ERROR] TaskScript:1: attempt to index nil");
		});
	});

	describe("unreachable backend", () => {
		it("should build the place then exit non-zero with an upload error", async () => {
			expect.assertions(2);

			// A no-`projects` config collapses into the multi pipeline, which
			// builds the place from the Rojo project (it no longer uploads a
			// pre-built `placeFile` as-is). With the backend unreachable the
			// build succeeds and the run fails at upload, surfacing a clear
			// "Failed to upload place".
			const sandbox = createFixtureSandbox(LUAU_FIXTURE);

			const result = await runCliAsync(["--backend", "open-cloud"], {
				cwd: sandbox,
				env: createOpenCloudEnvironment("http://127.0.0.1:1"),
			});

			expect(result.exitCode).toBeGreaterThan(0);
			expect(result.stderr).toContain("Failed to upload place");
		});
	});
});

function buildFailingPayload(): JestEnvelopePayload {
	return {
		runner: {
			setup: 0.05,
		},
		success: true,
		value: {
			numFailedTests: 1,
			numPassedTests: 0,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: 1_710_000_000_000,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "ReplicatedStorage/shared/example.spec",
					testResults: [
						{
							ancestorTitles: ["example"],
							duration: 12,
							failureMessages: ["expected hello but got world"],
							fullName: "example greets",
							status: "failed",
							title: "greets",
						},
					],
				},
			],
		},
	};
}
