import { appendFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isTaskCreatePost, startFakeOpenCloudServerAsync } from "./fake-open-cloud.ts";
import {
	buildMixedOutput,
	buildPassingPayload,
	createOpenCloudEnvironment,
	createRbxtsFixtureSandbox,
	patchSandboxConfig,
	rojoOnPath,
	runCliAsync,
} from "./helpers.ts";

const RBXTS_FIXTURE = path.resolve(__dirname, "../fixtures/rbxts-project");

/** Every stalled probe waits this out, so it stays short. */
const STALL_BUDGET_MS = 500;

const PASSING_TASK = { jestOutput: buildMixedOutput(buildPassingPayload()) };

/**
 * Shorten the boot probe's budget for a sandbox, so a spec that stalls the
 * probe on purpose costs seconds rather than the 90s a real cold boot is
 * allowed.
 */
function writeBootProbeTimeout(sandbox: string, bootProbeTimeout: number): void {
	patchSandboxConfig(sandbox, `bootProbeTimeout: ${String(bootProbeTimeout)},`);
}

describe("the boot probe gate", () => {
	it("should stop as boot unverified before any Jest task when both probes stall", async () => {
		expect.assertions(4);

		const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
		writeBootProbeTimeout(sandbox, STALL_BUDGET_MS);
		const server = await startFakeOpenCloudServerAsync([PASSING_TASK], {
			bootProbes: ["stall", "stall"],
		});

		const result = await runCliAsync([], {
			cwd: sandbox,
			env: createOpenCloudEnvironment(server.baseUrl),
		});

		// Exit 2 is the error signal, not the Jest failure signal.
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("boot unverified");
		// The first probe and the one extra probe, then nothing.
		expect(server.calls.filter(isTaskCreatePost)).toHaveLength(2);
		expect(server.requests).toHaveLength(0);
	});

	it("should run the tests once a second probe completes", async () => {
		expect.assertions(3);

		const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
		writeBootProbeTimeout(sandbox, STALL_BUDGET_MS);
		const server = await startFakeOpenCloudServerAsync([PASSING_TASK], {
			bootProbes: ["stall", "complete"],
		});

		const result = await runCliAsync([], {
			cwd: sandbox,
			env: createOpenCloudEnvironment(server.baseUrl),
		});

		expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
		// Two probes, then the one test task.
		expect(server.calls.filter(isTaskCreatePost)).toHaveLength(3);
		expect(server.requests).toHaveLength(1);
	});

	describe("proof reuse across runs", () => {
		it("should reuse a proven version without uploading or probing again", async () => {
			expect.assertions(4);

			const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
			const server = await startFakeOpenCloudServerAsync([PASSING_TASK, PASSING_TASK]);
			const environment = createOpenCloudEnvironment(server.baseUrl);

			await runCliAsync([], { cwd: sandbox, env: environment });
			const second = await runCliAsync([], { cwd: sandbox, env: environment });

			expect(second.exitCode, `stderr: ${second.stderr}`).toBe(0);
			expect(server.uploadCount).toBe(1);
			// One probe for the first run, then a test task per run.
			expect(server.calls.filter(isTaskCreatePost)).toHaveLength(3);
			expect(server.requests).toHaveLength(2);
		});

		// The place is built from `out/` by rojo, so the edit only reaches the
		// uploaded bytes when rojo can build.
		it.skipIf(!rojoOnPath())("should probe again when the place bytes change", async () => {
			expect.assertions(3);

			const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
			const server = await startFakeOpenCloudServerAsync([PASSING_TASK, PASSING_TASK]);
			const environment = createOpenCloudEnvironment(server.baseUrl);

			await runCliAsync([], { cwd: sandbox, env: environment });
			appendFileSync(path.join(sandbox, "out", "example.luau"), "\n-- changed\n");
			const second = await runCliAsync([], { cwd: sandbox, env: environment });

			expect(second.exitCode, `stderr: ${second.stderr}`).toBe(0);
			expect(server.uploadCount).toBe(2);
			// A probe and a test task per run.
			expect(server.calls.filter(isTaskCreatePost)).toHaveLength(4);
		});

		it("should probe again when the target place changes", async () => {
			expect.assertions(3);

			const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
			const server = await startFakeOpenCloudServerAsync([PASSING_TASK, PASSING_TASK]);
			const environment = createOpenCloudEnvironment(server.baseUrl);

			await runCliAsync([], { cwd: sandbox, env: environment });
			const second = await runCliAsync([], {
				cwd: sandbox,
				env: { ...environment, ROBLOX_PLACE_ID: "789" },
			});

			expect(second.exitCode, `stderr: ${second.stderr}`).toBe(0);
			expect(server.uploadCount).toBe(2);
			expect(server.calls.filter(isTaskCreatePost).map((call) => call.url)).toStrictEqual([
				expect.stringContaining("/places/456/versions/1/"),
				expect.stringContaining("/places/456/versions/1/"),
				expect.stringContaining("/places/789/versions/2/"),
				expect.stringContaining("/places/789/versions/2/"),
			]);
		});

		it("should probe again after a run that left its version unverified", async () => {
			expect.assertions(4);

			const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
			writeBootProbeTimeout(sandbox, STALL_BUDGET_MS);
			const server = await startFakeOpenCloudServerAsync([PASSING_TASK], {
				bootProbes: ["stall", "stall", "complete"],
			});
			const environment = createOpenCloudEnvironment(server.baseUrl);

			const first = await runCliAsync([], { cwd: sandbox, env: environment });
			const second = await runCliAsync([], { cwd: sandbox, env: environment });

			expect(first.exitCode).toBe(2);
			expect(second.exitCode, `stderr: ${second.stderr}`).toBe(0);
			expect(server.uploadCount).toBe(2);
			// Two lost probes, then a probe and the test task.
			expect(server.calls.filter(isTaskCreatePost)).toHaveLength(4);
		});
	});
});
