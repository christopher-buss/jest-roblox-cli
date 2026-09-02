import { placeVersionGuardSource } from "@isentinel/roblox-runner";
import {
	formatPlaceVersionRefusal,
	PLACE_VERSION_MISMATCH,
} from "@isentinel/roblox-runner/testing";

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

function isTaskCreatePost(call: { method: string; url: string }): boolean {
	return call.method === "POST" && call.url.endsWith("/luau-execution-session-tasks");
}

describe("optimistic place-version pinning", () => {
	it("should retry a raced task pinned to the uploaded version and still pass", async () => {
		expect.assertions(8);

		const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
		// First task boots on the wrong version (a concurrent upload won the
		// boot race) and returns the guard sentinel naming the version it did
		// boot; the pinned retry runs the suite for real.
		const server = await startFakeOpenCloudServerAsync([
			{ rawOutput: formatPlaceVersionRefusal(2) },
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
		expect(server.requests[0]!.script).toContain(placeVersionGuardSource(1));

		const taskPosts = server.calls.filter(isTaskCreatePost);

		// Three submits: the boot probe, pinned, then the run's first attempt
		// unpinned (warm-pool route) and its retry pinned to the version the
		// upload returned (the fake's first upload is v1).
		expect(taskPosts).toHaveLength(3);
		expect(taskPosts[0]!.url).toContain("/versions/1/");
		expect(taskPosts[1]!.url).not.toContain("/versions/");
		expect(taskPosts[2]!.url).toContain("/versions/1/");
		// The retry re-sends the original script with the guard stripped.
		expect(server.requests[1]!.script).not.toContain(PLACE_VERSION_MISMATCH);
	});
});
