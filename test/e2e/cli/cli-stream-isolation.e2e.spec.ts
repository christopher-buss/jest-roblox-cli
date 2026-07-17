import { type } from "arktype";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServer } from "./fake-open-cloud.ts";
import {
	buildMixedOutput,
	buildPassingPayload,
	createOpenCloudEnvironment,
	createRbxtsFixtureSandbox,
	runCliAsync,
} from "./helpers.ts";

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

		const result = await runCliAsync(["--formatters", "json"], {
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
