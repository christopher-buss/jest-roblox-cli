import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
	createFixtureSandbox,
	hostStudioEnvironment,
	IS_STUDIO_ON_HOST,
	runCliAsync,
} from "#test/e2e/cli/helpers.ts";

const WORKSPACE_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/workspace-studio");
const RUN_TIMEOUT_MS = 180_000;

describe("workspace studio-cli smoke", () => {
	it.runIf(IS_STUDIO_ON_HOST)(
		"should run every workspace package in one Studio process under backend studio-cli",
		async () => {
			expect.assertions(3);

			// Two-package workspace fixture (@e2e/studio-foo, @e2e/studio-bar).
			// studio-cli builds the synthesized mega-place (with `__pkg_stage`
			// staging) and the plugin runner clones each package from it, runs
			// Jest, resets — all in one Studio process (no sharding).
			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);
			const result = await runCliAsync(
				[
					"--workspace",
					"--packages=@e2e/studio-foo,@e2e/studio-bar",
					"--backend",
					"studio-cli",
				],
				{ cwd: sandbox, env: hostStudioEnvironment(), timeoutMs: RUN_TIMEOUT_MS },
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(result.stdout).toContain("@e2e/studio-foo");
			expect(result.stdout).toContain("@e2e/studio-bar");
		},
		RUN_TIMEOUT_MS + 5000,
	);
});
