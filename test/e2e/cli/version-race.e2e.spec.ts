import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { PLACE_VERSION_RACE_SENTINEL } from "../../../src/backends/open-cloud.ts";
import { startFakeOpenCloudServerAsync } from "./fake-open-cloud.ts";
import {
	buildMixedOutput,
	buildPassingPayload,
	createOpenCloudEnvironment,
	createRbxtsFixtureSandbox,
	runCliAsync,
} from "./helpers.ts";

const RBXTS_FIXTURE = path.resolve(__dirname, "../fixtures/rbxts-project");

function isTaskCreatePost(call: { method: string; url: string }): boolean {
	return call.method === "POST" && call.url.endsWith("/luau-execution-session-tasks");
}

describe("optimistic place-version pinning", () => {
	it("should retry a raced task pinned to the uploaded version and still pass", async () => {
		expect.assertions(7);

		const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
		// First task boots on the wrong version (a concurrent upload won the
		// boot race) and returns the guard sentinel naming the version it did
		// boot; the pinned retry runs the suite for real.
		const server = await startFakeOpenCloudServerAsync([
			{ rawOutput: `${PLACE_VERSION_RACE_SENTINEL}:2` },
			{ jestOutput: buildMixedOutput(buildPassingPayload()) },
		]);

		const result = await runCliAsync([], {
			cwd: sandbox,
			env: createOpenCloudEnvironment(server.baseUrl),
		});

		expect(result.exitCode).toBe(0);
		// The fake's first upload is v1, so booting v2 reads as a concurrent
		// upload rather than a stale cache entry.
		expect(result.stderr).toContain(
			"place version 1 raced by a concurrent upload — a task booted 2",
		);
		expect(server.requests[0]!.script).toContain(PLACE_VERSION_RACE_SENTINEL);

		const taskPosts = server.calls.filter(isTaskCreatePost);

		expect(taskPosts).toHaveLength(2);
		// First attempt is unpinned (warm-pool route), the retry is pinned to
		// the version the upload returned (the fake's first upload is v1).
		expect(taskPosts[0]!.url).not.toContain("/versions/");
		expect(taskPosts[1]!.url).toContain("/versions/1/");
		// The retry re-sends the original script with the guard stripped.
		expect(server.requests[1]!.script).not.toContain(PLACE_VERSION_RACE_SENTINEL);
	});
});
