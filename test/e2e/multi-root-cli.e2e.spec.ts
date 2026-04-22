import path from "node:path";
import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServer } from "./fake-open-cloud.ts";
import { createFixtureSandbox, runCliAsync } from "./helpers.ts";

const MULTI_ROOT_FIXTURE = path.resolve(__dirname, "fixtures/multi-root-project");

describe("multi-root CLI", () => {
	it("should run both mounts in one CLI invocation and merge the summary", async () => {
		expect.assertions(5);

		const sandbox = createFixtureSandbox(MULTI_ROOT_FIXTURE);
		const server = await startFakeOpenCloudServer([
			{
				jestOutput: buildMixedOutput({
					_setup: 0.05,
					success: true,
					value: {
						numFailedTests: 0,
						numPassedTests: 2,
						numPendingTests: 0,
						numTotalTests: 2,
						startTime: 1_710_000_000_000,
						success: true,
						testResults: [
							createPassingFileResult(
								"ReplicatedStorage/PkgShared/shared.spec.luau",
								"shared",
								"ReplicatedStorage/PkgShared",
							),
							createPassingFileResult(
								"ServerScriptService/PkgServer/server.spec.luau",
								"server",
								"ServerScriptService/PkgServer",
							),
						],
					},
				}),
			},
		]);

		const result = await runCliAsync(["--backend", "open-cloud", "--no-cache", "--verbose"], {
			cwd: sandbox,
			env: createOpenCloudEnvironment(server.baseUrl),
			timeoutMs: 25_000,
		});

		expect({ exitCode: result.exitCode, stderr: result.stderr }).toStrictEqual({
			exitCode: 0,
			stderr: "",
		});
		expect(result.stdout).toMatch(
			/ReplicatedStorage\/PkgShared[\s\S]*ServerScriptService\/PkgServer/,
		);
		expect(result.stdout).toContain("2 passed");
		expect(server.requests).toHaveLength(1);
		expect(server.requests[0]?.script).toMatch(
			/ReplicatedStorage\/PkgShared[\s\S]*ServerScriptService\/PkgServer/,
		);
	});
});

function buildMixedOutput(payload: Record<string, unknown>): string {
	return ["Preparing multi-root task", JSON.stringify(payload), "Running multi-root task"].join(
		"\n",
	);
}

function createOpenCloudEnvironment(baseUrl: string): Record<string, string> {
	return {
		JEST_ROBLOX_OPEN_CLOUD_BASE_URL: baseUrl,
		ROBLOX_OPEN_CLOUD_API_KEY: "test-api-key",
		ROBLOX_PLACE_ID: "456",
		ROBLOX_UNIVERSE_ID: "123",
	};
}

function createPassingFileResult(
	testFilePath: string,
	suite: string,
	title: string,
): Record<string, unknown> {
	return {
		numFailingTests: 0,
		numPassingTests: 1,
		numPendingTests: 0,
		testFilePath,
		testResults: [
			{
				ancestorTitles: [suite],
				duration: 9,
				failureMessages: [],
				fullName: `${suite} ${title}`,
				status: "passed",
				title,
			},
		],
	};
}
