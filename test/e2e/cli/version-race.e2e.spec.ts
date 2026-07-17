import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { PLACE_VERSION_RACE_SENTINEL } from "../../../src/backends/open-cloud.ts";
import { startFakeOpenCloudServer } from "./fake-open-cloud.ts";
import {
	buildMixedOutput,
	buildPassingPayload,
	createOpenCloudEnvironment,
	createRbxtsFixtureSandbox,
	runCliAsync,
} from "./helpers.ts";

const RBXTS_FIXTURE = path.resolve(__dirname, "../fixtures/rbxts-project");

describe("optimistic place-version pinning", () => {
	it("should retry a raced task pinned to the uploaded version and still pass", async () => {
		expect.assertions(7);

		const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
		// First task boots on the wrong version (a concurrent upload won the
		// boot race) and returns the guard sentinel; the pinned retry runs the
		// suite for real.
		const server = await startFakeOpenCloudServer([
			{ rawOutput: PLACE_VERSION_RACE_SENTINEL },
			{ jestOutput: buildMixedOutput(buildPassingPayload()) },
		]);

		const result = await runCliAsync([], {
			cwd: sandbox,
			env: createOpenCloudEnvironment(server.baseUrl),
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("place version raced");
		expect(server.requests[0]!.script).toContain(PLACE_VERSION_RACE_SENTINEL);

		const taskPosts = server.calls.filter(
			(call) => call.method === "POST" && call.url.endsWith("/luau-execution-session-tasks"),
		);

		expect(taskPosts).toHaveLength(2);
		// First attempt is unpinned (warm-pool route), the retry is pinned to
		// the version the upload returned (the fake's first upload is v1).
		expect(taskPosts[0]!.url).not.toContain("/versions/");
		expect(taskPosts[1]!.url).toContain("/versions/1/");
		// The retry re-sends the original script with the guard stripped.
		expect(server.requests[1]!.script).not.toContain(PLACE_VERSION_RACE_SENTINEL);
	});
});
