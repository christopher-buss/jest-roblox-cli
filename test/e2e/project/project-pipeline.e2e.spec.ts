import { type } from "arktype";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { createFixtureSandbox, runCliAsync } from "../cli/helpers.ts";

// Live single-project pipeline tests. Both gated on JEST_ROBLOX_LIVE=1 plus
// the three Open Cloud env vars (`ROBLOX_OPEN_CLOUD_API_KEY`,
// `ROBLOX_UNIVERSE_ID`, `ROBLOX_PLACE_ID`). When the gate is off these tests
// stay dormant — vitest reports them as skipped, the live wire is never
// touched, and the file can run on machines without secrets.
//
// The fixture (`test/e2e/fixtures/live-place`) ships a pre-built `.rbxl` plus
// two configured `projects` in its `jest.config.ts`. We restrict the run to
// `live-place-shared` (one passing spec) so the assertion can target
// "1 passed" deterministically, regardless of how the second mount evolves.

const LIVE_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/live-place");
const RUN_TIMEOUT_MS = 120_000;

const isLive = process.env["JEST_ROBLOX_LIVE"] === "1";

const coverageEntrySchema = type({
	s: { "[string]": "number" },
});
const coverageReportSchema = type({
	"[string]": coverageEntrySchema,
});

describe("live project pipeline", () => {
	it.runIf(isLive)(
		"should pass end-to-end against live Open Cloud",
		async () => {
			expect.assertions(2);

			const sandbox = createFixtureSandbox(LIVE_FIXTURE_PATH);
			const result = await runCliAsync(
				[
					"--backend",
					"open-cloud",
					"--config",
					"jest.config.ts",
					"--project",
					"live-place-shared",
				],
				{
					cwd: sandbox,
					env: liveEnvironment(),
					timeoutMs: RUN_TIMEOUT_MS,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(result.stdout).toContain("1 passed");
		},
		RUN_TIMEOUT_MS + 5000,
	);

	it.runIf(isLive)(
		"should produce a typescript-keyed coverage report with non-zero statement counts",
		async () => {
			expect.assertions(4);

			const sandbox = createFixtureSandbox(LIVE_FIXTURE_PATH);
			const result = await runCliAsync(
				[
					"--backend",
					"open-cloud",
					"--config",
					"jest.config.ts",
					"--project",
					"live-place-shared",
					"--coverage",
					"--coverageReporters",
					"json",
				],
				{
					cwd: sandbox,
					env: liveEnvironment(),
					timeoutMs: RUN_TIMEOUT_MS,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);

			const reportPath = path.join(sandbox, "coverage", "coverage-final.json");

			expect(fs.existsSync(reportPath)).toBeTrue();

			const raw = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
			const report = coverageReportSchema.assert(raw);
			const keys = Object.keys(report);

			expect(keys.some((key) => key.endsWith(".ts"))).toBeTrue();
			expect(
				Object.values(report).some((entry) =>
					Object.values(entry.s).some((count) => count > 0),
				),
			).toBeTrue();
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
