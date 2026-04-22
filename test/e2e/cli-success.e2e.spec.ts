import { type } from "arktype";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServer } from "./fake-open-cloud.ts";
import { createFixtureSandbox, runCliAsync } from "./helpers.ts";

const RBXTS_FIXTURE = path.resolve(__dirname, "fixtures/rbxts-project");

const jsonResultSchema = type({
	numPassedTests: "number",
	numTotalTests: "number",
	success: "boolean",
	testResults: "object[]",
});

describe("cli success", () => {
	it("should print the human formatter summary for a successful mixed-output run", async () => {
		expect.assertions(5);

		const sandbox = createFixtureSandbox(RBXTS_FIXTURE);
		const server = await startFakeOpenCloudServer([
			{
				jestOutput: buildMixedOutput(
					buildPassingPayload({
						setupSeconds: 0.25,
						testFilePath: "ReplicatedStorage/shared/example.spec",
					}),
				),
				pollsBeforeComplete: 1,
			},
		]);

		const result = await runCliAsync(["--backend", "open-cloud", "--no-cache"], {
			cwd: sandbox,
			env: createOpenCloudEnvironment(server.baseUrl),
		});

		expect({ exitCode: result.exitCode, stderr: result.stderr }).toStrictEqual({
			exitCode: 0,
			stderr: "",
		});
		expect(result.stdout).toContain("Duration");
		expect(result.stdout).toMatch(/setup 250ms/);
		expect(result.stdout).toContain("1 passed");
		expect(server.uploadCount).toBe(1);
	});

	it("should print parseable JSON when --formatters json is selected", async () => {
		expect.assertions(5);

		const sandbox = createFixtureSandbox(RBXTS_FIXTURE);
		const server = await startFakeOpenCloudServer([
			{
				jestOutput: buildMixedOutput(
					buildPassingPayload({
						setupSeconds: 0.125,
						testFilePath: "ReplicatedStorage/shared/example.spec",
					}),
				),
			},
		]);

		const result = await runCliAsync(
			["--backend", "open-cloud", "--no-cache", "--formatters", "json"],
			{
				cwd: sandbox,
				env: createOpenCloudEnvironment(server.baseUrl),
			},
		);
		const parsed = jsonResultSchema.assert(JSON.parse(result.stdout));

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(parsed.success).toBeTrue();
		expect(parsed.numPassedTests).toBe(1);
		expect(parsed.numTotalTests).toBe(1);
	});
});

function buildMixedOutput(payload: Record<string, unknown>): string {
	return [
		"Booting fake Roblox runner",
		JSON.stringify(payload),
		"Finished fake Roblox runner",
	].join("\n");
}

function buildPassingPayload(options: {
	setupSeconds: number;
	testFilePath: string;
}): Record<string, unknown> {
	return {
		_setup: options.setupSeconds,
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
					testFilePath: options.testFilePath,
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
