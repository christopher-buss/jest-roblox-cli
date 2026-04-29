import path from "node:path";
import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServer } from "./fake-open-cloud.ts";
import { createFixtureSandbox, createRbxtsFixtureSandbox, runCliAsync } from "./helpers.ts";

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

			const result = await runCliAsync(["--no-cache"], {
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

			const result = await runCliAsync(["--backend", "open-cloud", "--no-cache"], {
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
					// timeout. The backend will exhaust its poll budget and
					// throw "Execution timed out" before this counter drains.
					pollsBeforeComplete: 999,
				},
			]);

			const result = await runCliAsync(
				["--no-cache", "--timeout", "2000", "--pollInterval", "100"],
				{
					cwd: sandbox,
					env: createOpenCloudEnvironment(server.baseUrl),
					timeoutMs: 30_000,
				},
			);

			expect(result.exitCode).toBeGreaterThan(0);
			expect(result.stderr).toMatch(/timed out/i);
		});
	});

	describe("invalid place file", () => {
		it("should exit non-zero and name the missing place file path", async () => {
			expect.assertions(3);

			// LUAU_FIXTURE goes through the single-project path, which skips
			// the rojo build step. The backend reads placeFile directly, so a
			// missing file surfaces as ENOENT naming the resolved path.
			const sandbox = createFixtureSandbox(LUAU_FIXTURE);

			const result = await runCliAsync(["--backend", "open-cloud", "--no-cache"], {
				cwd: sandbox,
				env: createOpenCloudEnvironment("http://127.0.0.1:1"),
			});

			expect(result.exitCode).toBeGreaterThan(0);
			expect(result.stderr).toContain("ENOENT");
			expect(result.stderr).toContain("game.rbxl");
		});
	});
});

function buildMixedOutput(payload: Record<string, unknown>): string {
	return [
		"Booting fake Roblox runner",
		JSON.stringify(payload),
		"Finished fake Roblox runner",
	].join("\n");
}

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

function buildPassingPayload(): Record<string, unknown> {
	return {
		_setup: 0.05,
		success: true,
		value: {
			numFailedTests: 0,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: 1_710_000_000_000,
			success: true,
			testResults: [
				{
					numFailingTests: 0,
					numPassingTests: 1,
					numPendingTests: 0,
					testFilePath: "ReplicatedStorage/shared/example.spec",
					testResults: [
						{
							ancestorTitles: ["example"],
							duration: 12,
							failureMessages: [],
							fullName: "example greets",
							status: "passed",
							title: "greets",
						},
					],
				},
			],
		},
	};
}

function createOpenCloudEnvironment(baseUrl: string): Record<string, string> {
	return {
		JEST_ROBLOX_OPEN_CLOUD_BASE_URL: baseUrl,
		ROBLOX_OPEN_CLOUD_API_KEY: "test-api-key",
		ROBLOX_PLACE_ID: "456",
		ROBLOX_UNIVERSE_ID: "123",
	};
}
