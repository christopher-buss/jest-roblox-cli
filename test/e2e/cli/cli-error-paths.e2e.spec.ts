import path from "node:path";
import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServer } from "./fake-open-cloud.ts";
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

describe("cli error paths", () => {
	describe("exit codes", () => {
		it("should exit 1 when the Jest payload reports failed tests", async () => {
			expect.assertions(2);

			const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
			const server = await startFakeOpenCloudServer([
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

		it("should exit non-zero with a 'timed out' message when the backend never completes", async () => {
			expect.assertions(2);

			const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
			const server = await startFakeOpenCloudServer([
				{
					jestOutput: buildMixedOutput(buildPassingPayload()),
					// Stall on PROCESSING longer than the configured CLI
					// timeout. The backend exhausts its timeout budget and
					// throws "Execution timed out" before this counter drains.
					pollsBeforeComplete: 999,
				},
			]);

			const result = await runCliAsync(["--timeout", "2000"], {
				cwd: sandbox,
				env: createOpenCloudEnvironment(server.baseUrl),
				timeoutMs: 30_000,
			});

			expect(result.exitCode).toBeGreaterThan(0);
			expect(result.stderr).toMatch(/timed out/i);
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

function buildFailingPayload(): Record<string, unknown> {
	return {
		_setup: 0.05,
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
