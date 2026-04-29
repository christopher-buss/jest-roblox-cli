import * as path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

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
const RUN_TIMEOUT_MS = 120_000;

const isLive = process.env["JEST_ROBLOX_LIVE"] === "1";

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

function liveEnvironment(): Record<string, string | undefined> {
	return {
		JEST_ROBLOX_LIVE: process.env["JEST_ROBLOX_LIVE"],
		ROBLOX_OPEN_CLOUD_API_KEY: process.env["ROBLOX_OPEN_CLOUD_API_KEY"],
		ROBLOX_PLACE_ID: process.env["ROBLOX_PLACE_ID"],
		ROBLOX_UNIVERSE_ID: process.env["ROBLOX_UNIVERSE_ID"],
	};
}
