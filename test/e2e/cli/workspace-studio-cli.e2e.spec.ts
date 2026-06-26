import * as path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { createFixtureSandbox, runCliAsync } from "./helpers.ts";

const WORKSPACE_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/workspace");
const RUN_TIMEOUT_MS = 180_000;

// studio-cli launches a real Roblox Studio process and drives the installed
// jest-roblox plugin's Run-mode runner. The Luau runner change (workspace
// dispatch + protocol-version echo) cannot be unit-tested off-process, so it is
// verified by this gated end-to-end smoke — the studio-cli analogue of the live
// OCALE shards. It needs Studio installed, the developer logged in, and the
// plugin installed, so it can't run in CI. It stays dormant unless a developer
// opts in with `JEST_ROBLOX_STUDIO_LIVE=1`; with the gate off, vitest reports it
// skipped and the file runs on any machine without secrets or Studio.
const isStudioLive = process.env["JEST_ROBLOX_STUDIO_LIVE"] === "1";

describe("workspace studio-cli smoke", () => {
	it.runIf(isStudioLive)(
		"should run every workspace package in one Studio process under backend studio-cli",
		async () => {
			expect.assertions(3);

			// Two-package workspace fixture (@e2e/foo, @e2e/bar). studio-cli
			// builds the synthesized mega-place (with `__pkg_stage` staging) and
			// the plugin runner clones each package from it, runs Jest, resets —
			// all in one Studio process (no sharding).
			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);
			const result = await runCliAsync(
				["--workspace", "--packages=@e2e/foo,@e2e/bar", "--backend", "studio-cli"],
				{ cwd: sandbox, timeoutMs: RUN_TIMEOUT_MS },
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(result.stdout).toContain("@e2e/foo");
			expect(result.stdout).toContain("@e2e/bar");
		},
		RUN_TIMEOUT_MS + 5000,
	);
});
