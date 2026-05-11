import * as cp from "node:child_process";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServer } from "../cli/fake-open-cloud.ts";
import { createFixtureSandbox, runCliAsync } from "../cli/helpers.ts";

// Live multi-root workspace pipeline test. Gated on JEST_ROBLOX_LIVE=1 plus
// the three Open Cloud env vars (`ROBLOX_OPEN_CLOUD_API_KEY`,
// `ROBLOX_UNIVERSE_ID`, `ROBLOX_PLACE_ID`). When the gate is off the test
// stays dormant — vitest reports it as skipped, the live wire is never
// touched, and the file can run on machines without secrets.
//
// The fixture (`test/e2e/fixtures/live-place`) ships a pre-built `.rbxl` plus
// two configured `projects` in its `jest.config.ts` (`live-place-shared` and
// `live-place-server`). Running without `--project` exercises both mounts so
// the assertion verifies the multi-root pipeline merges results across them.

const LIVE_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/live-place");
const WORKSPACE_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/workspace");
const RUN_TIMEOUT_MS = 120_000;

const isLive = process.env["JEST_ROBLOX_LIVE"] === "1";

function rojoOnPath(): boolean {
	try {
		cp.execFileSync("rojo", ["--version"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

describe("live workspace pipeline", () => {
	it.runIf(isLive)(
		"should merge results from both mounts end-to-end against live Open Cloud",
		async () => {
			expect.assertions(4);

			const sandbox = createFixtureSandbox(LIVE_FIXTURE_PATH);
			const result = await runCliAsync(
				["--backend", "open-cloud", "--config", "jest.config.ts"],
				{
					cwd: sandbox,
					env: liveEnvironment(),
					timeoutMs: RUN_TIMEOUT_MS,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(result.stdout).toContain("2 passed");
			expect(result.stdout).toContain("live-place-shared");
			expect(result.stdout).toContain("live-place-server");
		},
		RUN_TIMEOUT_MS + 5000,
	);
});

// Workspace + --parallel exercises the work-stealing path: per-run MemoryStore
// queue populated with every (pkg, project), N OCALE tasks all running the
// same materializer script, and entries from all envelopes aggregated by
// pkg::project. Driven through the fake Open Cloud server so the test stays
// fast and runs without secrets.
describe("workspace --parallel work-stealing", () => {
	it.skipIf(!rojoOnPath())(
		"should populate the MemoryStore queue and fan results across N parallel tasks",
		async () => {
			expect.assertions(5);

			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);

			const server = await startFakeOpenCloudServer([
				{ jestOutput: passingJestOutput(), pkg: "@e2e/foo", project: "@e2e/foo" },
				{ jestOutput: passingJestOutput(), pkg: "@e2e/bar", project: "@e2e/bar" },
			]);

			const result = await runCliAsync(
				[
					"--workspace",
					"--packages=@e2e/foo,@e2e/bar",
					"--parallel=2",
					"--backend",
					"open-cloud",
					"--no-cache",
				],
				{
					cwd: sandbox,
					env: {
						JEST_ROBLOX_OPEN_CLOUD_BASE_URL: server.baseUrl,
						ROBLOX_OPEN_CLOUD_API_KEY: "test-api-key",
						ROBLOX_PLACE_ID: "456",
						ROBLOX_UNIVERSE_ID: "123",
					},
					timeoutMs: 60_000,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			// Both packages get pushed onto the per-run queue.
			expect(server.queueAdds.map((entry) => entry.value)).toIncludeAllMembers([
				{ pkg: "@e2e/foo", project: "@e2e/foo" },
				{ pkg: "@e2e/bar", project: "@e2e/bar" },
			]);
			// Two parallel tasks fired against the same shared queueId.
			expect(server.requests).toHaveLength(2);

			const queueIds = server.requests.map(
				(request) => /"queueId":"([^"]+)"/.exec(request.script)?.[1] ?? "",
			);

			expect(new Set(queueIds).size).toBe(1);
			// Single place upload regardless of --parallel.
			expect(server.uploadCount).toBe(1);
		},
		60_000,
	);
});

// Regression: a package whose rojo declares a `$path`-mounted parent (e.g.
// `Tests: { $path: "out-test" }`) with no explicit child for the sub-directory
// targeted by `outDir: "out-test/src"`. Before the synthesizer learned to
// virtualize the missing `Tests/src` child from the on-disk directory, the
// workspace runner crashed with `stubMount dataModelPath ... does not resolve
// in synthesized tree (missing segment "src")` before reaching the backend.
describe("workspace synthesizer $path-mounted parent virtualization", () => {
	it.skipIf(!rojoOnPath())(
		"should reach backend dispatch when stubMount targets a sub-directory of a $path-mounted parent",
		async () => {
			expect.assertions(4);

			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);

			const server = await startFakeOpenCloudServer([
				{
					jestOutput: passingJestOutput(),
					pkg: "@e2e/nested",
					project: "@e2e/nested",
				},
			]);

			const result = await runCliAsync(
				["--workspace", "--packages=@e2e/nested", "--backend", "open-cloud", "--no-cache"],
				{
					cwd: sandbox,
					env: {
						JEST_ROBLOX_OPEN_CLOUD_BASE_URL: server.baseUrl,
						ROBLOX_OPEN_CLOUD_API_KEY: "test-api-key",
						ROBLOX_PLACE_ID: "456",
						ROBLOX_UNIVERSE_ID: "123",
					},
					timeoutMs: 60_000,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(result.stderr).not.toContain("does not resolve in synthesized tree");
			// Guard against silent short-circuits (e.g. zero-discovery passes
			// without ever reaching backend dispatch).
			expect(server.requests).toHaveLength(1);
			expect(server.uploadCount).toBe(1);
		},
		60_000,
	);
});

function liveEnvironment(): Record<string, string | undefined> {
	return {
		JEST_ROBLOX_LIVE: process.env["JEST_ROBLOX_LIVE"],
		ROBLOX_OPEN_CLOUD_API_KEY: process.env["ROBLOX_OPEN_CLOUD_API_KEY"],
		ROBLOX_PLACE_ID: process.env["ROBLOX_PLACE_ID"],
		ROBLOX_UNIVERSE_ID: process.env["ROBLOX_UNIVERSE_ID"],
	};
}

function passingJestOutput(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: 0,
		success: true,
		testResults: [],
		...overrides,
	});
}
