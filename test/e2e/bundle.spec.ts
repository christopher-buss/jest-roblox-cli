import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { startFakeOpenCloudServerAsync } from "#test/harness/fake-open-cloud.ts";

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

async function builtBackendAsync(baseUrl: string) {
	vi.stubEnv("JEST_ROBLOX_OCALE_MAX_RETRIES", undefined);
	vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_BASE_URL", baseUrl);
	const built =
		await vi.importActual<typeof import("@isentinel/jest-roblox/api")>("../../dist/api.mjs");
	const credentials = { apiKey: "fake", placeId: "456", universeId: "123" };
	return {
		backend: new built.OpenCloudBackend(credentials),
		buildJestArgv: built.buildJestArgv,
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
	return JSON.stringify({ entries: [{ jestOutput: value, jobIndex: 0 }] });
}

describe("published bundle", () => {
	it("should recover an upload connection reset through the built backend", async () => {
		expect.assertions(2);

		const server = await startFakeOpenCloudServerAsync([{ rawOutput: envelope("complete") }], {
			uploadConnectionResets: 1,
		});
		const { backend, buildJestArgv, config } = await builtBackendAsync(server.baseUrl);
		const result = await backend.runTestsAsync({
			jobs: [{ argv: buildJestArgv({ config }), displayName: "bundle", testFiles: [] }],
			runSettings: config,
			sharding: { kind: "static", parallel: undefined },
		});

		expect(result.rawResults[0]!.entry.jestOutput).toBe("complete");
		expect(server.calls.filter(({ url }) => url.includes("/versions?"))).toHaveLength(2);
	});
});
