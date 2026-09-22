import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { startFakeOpenCloudServerAsync } from "./cli/fake-open-cloud.ts";

function temporaryPlace(): { placeFile: string; rootDir: string } {
	const rootDirectory = mkdtempSync(path.join(tmpdir(), "jest-roblox-bundle-"));
	const placeFile = "place.rbxl";
	copyFileSync(
		path.resolve(import.meta.dirname, "fixtures/live-place/game.rbxl"),
		path.join(rootDirectory, placeFile),
	);
	onTestFinished(() => {
		rmSync(rootDirectory, { force: true, recursive: true });
	});
	return { placeFile, rootDir: rootDirectory };
}

async function builtBackendAsync(baseUrl: string, bootWatchMs = 5) {
	vi.stubEnv("JEST_ROBLOX_OCALE_MAX_RETRIES", undefined);
	vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_BASE_URL", baseUrl);
	const built =
		await vi.importActual<typeof import("../../src/index.ts")>("../../dist/index.mjs");
	const credentials = { apiKey: "fake", placeId: "456", universeId: "123" };
	return {
		backend: new built.OpenCloudBackend(credentials, { bootWatchMs }),
		config: {
			...built.DEFAULT_CONFIG,
			...temporaryPlace(),
			bootProbeTimeout: 0,
			timeout: 1_000,
			uploadCache: false,
		},
	};
}

function envelope(value: string): string {
	return JSON.stringify({ entries: [{ jestOutput: value }] });
}

function taskGetCount(calls: Array<{ method: string; url: string }>, taskName: string): number {
	return calls
		.filter(({ method }) => method === "GET")
		.filter(({ url }) => url.includes(taskName)).length;
}

describe("published bundle", () => {
	it("should recover an upload connection reset through the built backend", async () => {
		expect.assertions(2);

		const server = await startFakeOpenCloudServerAsync([{ rawOutput: envelope("complete") }], {
			uploadConnectionResets: 1,
		});
		const { backend, config } = await builtBackendAsync(server.baseUrl);
		const result = await backend.runTestsAsync({
			jobs: [{ config, displayName: "bundle", testFiles: [] }],
			scriptOverride: 'return "result"',
		});

		expect(result.rawResults[0]!.entry.jestOutput).toBe("complete");
		expect(server.calls.filter(({ url }) => url.includes("/versions?"))).toHaveLength(2);
	});

	it("should stop the superseded observer after a replacement succeeds", async () => {
		expect.assertions(3);

		const server = await startFakeOpenCloudServerAsync(
			[
				{ pollsBeforeComplete: Number.MAX_SAFE_INTEGER },
				{ rawOutput: envelope("replacement") },
			],
			{ executionClaim: "missing" },
		);
		const { backend, config } = await builtBackendAsync(server.baseUrl);
		const result = await backend.runTestsAsync({
			jobs: [{ config, displayName: "bundle", testFiles: [] }],
			scriptOverride: 'return "result"',
		});

		expect(result.rawResults[0]!.entry.jestOutput).toBe("replacement");

		function originalTaskGets(): number {
			return taskGetCount(server.calls, "/tasks/task-1");
		}

		const settledCount = originalTaskGets();

		expect(settledCount).toBeGreaterThan(0);

		await sleep(1_100);

		expect(originalTaskGets()).toBe(settledCount);
	});

	it("should retry a resource-exhausted submission through the built backend", async () => {
		expect.assertions(2);

		const server = await startFakeOpenCloudServerAsync([{ rawOutput: envelope("complete") }], {
			submitFailures: [
				{
					body: {
						error: {
							code: "RESOURCE_EXHAUSTED",
							message: "Too many tasks already active for this place",
						},
					},
					headers: { "retry-after": "0" },
					status: 429,
				},
			],
		});
		const { backend, config } = await builtBackendAsync(server.baseUrl);
		const result = await backend.runTestsAsync({
			jobs: [{ config, displayName: "bundle", testFiles: [] }],
			scriptOverride: 'return "result"',
		});

		expect(result.rawResults[0]!.entry.jestOutput).toBe("complete");
		expect(server.requests).toHaveLength(2);
	});
});
