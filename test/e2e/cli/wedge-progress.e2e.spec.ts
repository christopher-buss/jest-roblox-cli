import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServerAsync } from "./fake-open-cloud.ts";
import {
	buildMixedOutput,
	buildPassingPayload,
	createOpenCloudEnvironment,
	createRbxtsFixtureSandbox,
	runCliAsync,
} from "./helpers.ts";

const RBXTS_FIXTURE = path.resolve(__dirname, "../fixtures/rbxts-project");

/** The `progress` block the CLI bakes into the payload it dispatches. */
const PROGRESS_PAYLOAD = /"progress":\{"mapId":"[\da-f-]{36}"\}/;

describe("per-test progress map", () => {
	it("should bake a per-run progress map into the dispatched script", async () => {
		expect.assertions(2);

		const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
		const server = await startFakeOpenCloudServerAsync([
			{ jestOutput: buildMixedOutput(buildPassingPayload()) },
		]);

		const result = await runCliAsync([], {
			cwd: sandbox,
			env: createOpenCloudEnvironment(server.baseUrl),
		});

		expect(result.exitCode).toBe(0);
		// The runtime writes into this map as it goes, so a task that never
		// comes back still leaves the test it reached behind.
		expect(server.requests[0]!.script).toMatch(PROGRESS_PAYLOAD);
	});
});
