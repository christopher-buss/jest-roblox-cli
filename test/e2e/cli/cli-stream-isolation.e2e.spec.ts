import { type } from "arktype";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServer } from "./fake-open-cloud.ts";
import { createRbxtsFixtureSandbox, runCliAsync } from "./helpers.ts";

const RBXTS_FIXTURE = path.resolve(__dirname, "../fixtures/rbxts-project");

const jsonResultSchema = type({
	numPassedTests: "number",
	numTotalTests: "number",
	success: "boolean",
	testResults: "object[]",
});

describe("--formatters json stream isolation", () => {
	it("should emit only JSON on stdout and keep human-facing logs on stderr", async () => {
		expect.assertions(5);

		const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
		const server = await startFakeOpenCloudServer([
			{
				jestOutput: buildMixedOutput(buildPassingPayload()),
			},
		]);

		const result = await runCliAsync(["--no-cache", "--formatters", "json"], {
			cwd: sandbox,
			env: createOpenCloudEnvironment(server.baseUrl),
		});

		expect(result.exitCode).toBe(0);
		// stdout must start with `{` so downstream JSON consumers can pipe it
		// directly without log-noise stripping.
		expect(result.stdout.trimStart().startsWith("{")).toBeTrue();

		// JSON.parse must succeed without throwing.
		const parsed = jsonResultSchema.assert(JSON.parse(result.stdout));

		expect(parsed.success).toBeTrue();
		expect(parsed.numPassedTests).toBe(1);
		// resolveBackend writes "Backend: open-cloud (no plugin, using Open
		// Cloud)" to stderr when auto-detecting. This confirms human-facing
		// log lines went to stderr instead of polluting the JSON channel on
		// stdout.
		expect(result.stderr).toContain("Backend: open-cloud");
	});
});

function buildMixedOutput(payload: Record<string, unknown>): string {
	return [
		"Booting fake Roblox runner",
		JSON.stringify(payload),
		"Finished fake Roblox runner",
	].join("\n");
}

function buildPassingPayload(): Record<string, unknown> {
	return {
		_setup: 0.1,
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
