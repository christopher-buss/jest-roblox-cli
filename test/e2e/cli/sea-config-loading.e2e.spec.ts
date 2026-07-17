import path from "node:path";
import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServer } from "./fake-open-cloud.ts";
import {
	buildMixedOutput,
	buildPassingPayload,
	createFixtureSandbox,
	createOpenCloudEnvironment,
	createRbxtsFixtureSandbox,
	runCliAsync,
} from "./helpers.ts";

const RBXTS_FIXTURE = path.resolve(__dirname, "../fixtures/rbxts-project");
const WORKSPACE_FIXTURE = path.resolve(__dirname, "../fixtures/workspace");

// Strip every Open Cloud credential so a run halts right after config discovery
// — reaching the credential check proves the configs loaded.
const NO_OPEN_CLOUD_CREDENTIALS = {
	JEST_ROBLOX_OPEN_CLOUD_API_KEY: undefined,
	JEST_ROBLOX_PLACE_ID: undefined,
	JEST_ROBLOX_UNIVERSE_ID: undefined,
	ROBLOX_OPEN_CLOUD_API_KEY: undefined,
	ROBLOX_PLACE_ID: undefined,
	ROBLOX_UNIVERSE_ID: undefined,
} as const;

// A SEA binary can't `import()` a config off disk, and only the `.json` branch
// of `seaImport` was ever SEA-safe, so any `.ts`/`.js` config failed before the
// run began. These specs drive the real CLI as a child process with
// `JEST_ROBLOX_SEA=true`, routing config discovery through `seaImport` over
// genuine Node module resolution (`createRequire`) rather than Vitest's
// path-tolerant import runner.
describe("sea config loading", () => {
	it("should load a `.ts` config under the SEA loader and run to completion", async () => {
		expect.assertions(2);

		// The rbxts fixture's `jest.config.ts` imports `defineConfig` from
		// `@isentinel/jest-roblox` — a runtime value resolved from the sandbox's
		// `node_modules`, exercising the import caveat end to end.
		const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
		const server = await startFakeOpenCloudServer([
			{
				jestOutput: buildMixedOutput(buildPassingPayload()),
			},
		]);

		const result = await runCliAsync([], {
			cwd: sandbox,
			env: { ...createOpenCloudEnvironment(server.baseUrl), JEST_ROBLOX_SEA: "true" },
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("1 passed");
	});

	it("should enumerate and load every package's `.ts` config in workspace mode", async () => {
		expect.assertions(2);

		// The headline failure: workspace mode "breaks on the first package it
		// enumerates" because each package config goes through `seaImport`.
		// Reaching the Open-Cloud credential check proves both `@e2e/foo` and
		// `@e2e/bar` `.ts` configs loaded — discovery ran to completion.
		const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE);

		const result = await runCliAsync(
			["--workspace", "--packages=@e2e/foo,@e2e/bar", "--backend", "open-cloud"],
			{ cwd: sandbox, env: { ...NO_OPEN_CLOUD_CREDENTIALS, JEST_ROBLOX_SEA: "true" } },
		);

		expect(result.exitCode).toBeGreaterThan(0);
		expect(result.stderr).toContain("Missing: apiKey, universeId, placeId");
	});
});
