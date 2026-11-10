import path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import type { JestResult } from "#src/api.ts";
import { loadConfig } from "#src/api.ts";
import { runAsync } from "#src/cli.ts";
import { startFakeOpenCloudServerAsync } from "#test/harness/fake-open-cloud.ts";
import { createFixtureSandbox } from "#test/harness/helpers.ts";

const MULTI_ROOT_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/multi-root-project");

const SHARED_MOUNT = "ReplicatedStorage/PkgShared";
const SERVER_MOUNT = "ServerScriptService/PkgServer";

function buildMergedJestResult(): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: 2,
		numPendingTests: 0,
		numTotalTests: 2,
		startTime: 1_710_000_000_000,
		success: true,
		testResults: [
			{
				numFailingTests: 0,
				numPassingTests: 1,
				numPendingTests: 0,
				testFilePath: `${SHARED_MOUNT}/shared.spec.luau`,
				testResults: [
					{
						ancestorTitles: ["shared"],
						duration: 9,
						failureMessages: [],
						fullName: "shared shared",
						status: "passed",
						title: "shared",
					},
				],
			},
			{
				numFailingTests: 0,
				numPassingTests: 1,
				numPendingTests: 0,
				testFilePath: `${SERVER_MOUNT}/server.spec.luau`,
				testResults: [
					{
						ancestorTitles: ["server"],
						duration: 9,
						failureMessages: [],
						fullName: "server server",
						status: "passed",
						title: "server",
					},
				],
			},
		],
	};
}

describe("executor multi-root pipeline", () => {
	it("should drive a single backend invocation that mentions both rojo mounts", async () => {
		expect.assertions(4);

		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const sandbox = createFixtureSandbox(MULTI_ROOT_FIXTURE);
		const jestOutput = JSON.stringify({
			runner: { setup: 0.05 },
			...buildMergedJestResult(),
		});
		const server = await startFakeOpenCloudServerAsync([{ jestOutput }]);
		vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_BASE_URL", server.baseUrl);

		const exitCode = await runAsync(
			[
				"--backend",
				"open-cloud",
				"--apiKey",
				"fake",
				"--universeId",
				"123",
				"--placeId",
				"456",
			],
			{
				loadConfig: async () => {
					return {
						...(await loadConfig({ cwd: sandbox })),
						bootProbeTimeout: 0,
						uploadCache: false,
					};
				},
			},
		);

		expect(exitCode).toBe(0);
		expect(server.requests).toHaveLength(1);
		expect(server.requests[0]!.script).toMatch(
			new RegExp(`${SHARED_MOUNT}[\\s\\S]*${SERVER_MOUNT}`),
		);
		expect(
			[...stdout.mock.calls, ...log.mock.calls].map(([chunk]) => String(chunk)).join(""),
		).toContain("2 passed");
	});
});
