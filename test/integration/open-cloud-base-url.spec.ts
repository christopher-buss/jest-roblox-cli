import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { startFakeOpenCloudServerAsync } from "#test/e2e/cli/fake-open-cloud.ts";
import { DEFAULT_CONFIG, OpenCloudBackend } from "../../src/index.ts";

const credentials = { apiKey: "test-api-key", placeId: "456", universeId: "123" };
function successJest(): string {
	return JSON.stringify({
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: 0,
		success: true,
		testResults: [],
	});
}

function cacheJob(rootDirectory: string, overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
	return {
		config: { ...DEFAULT_CONFIG, rootDir: rootDirectory, ...overrides },
		displayColor: "alpha-color",
		displayName: "alpha",
		pkg: undefined,
		testFiles: ["alpha/test.spec.ts"],
	};
}

function localOnlyFetch(
	baseUrl: string,
	fetchAsync: typeof globalThis.fetch,
): typeof globalThis.fetch {
	return async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.startsWith(baseUrl)) {
			return fetchAsync(input, init);
		}

		return new Response(
			JSON.stringify({ error: { message: "Unexpected non-local request" } }),
			{
				headers: { "content-type": "application/json" },
				status: 401,
			},
		);
	};
}

describe(OpenCloudBackend, () => {
	it("should run through the configured Open Cloud base URL", { timeout: 1000 }, async () => {
		expect.assertions(3);

		const server = await startFakeOpenCloudServerAsync([{ jestOutput: successJest() }]);
		const fetchAsync = globalThis.fetch;
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(localOnlyFetch(server.baseUrl, fetchAsync));
		onTestFinished(() => {
			fetch.mockRestore();
		});
		vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_BASE_URL", server.baseUrl);
		const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "open-cloud-url-"));
		onTestFinished(() => {
			fs.rmSync(rootDirectory, { force: true, recursive: true });
		});
		fs.writeFileSync(path.join(rootDirectory, "place.rbxlx"), '<roblox version="4"></roblox>');

		const backend = new OpenCloudBackend(credentials);
		const result = await backend.runTestsAsync({
			jobs: [cacheJob(rootDirectory, { bootProbeTimeout: 0, placeFile: "place.rbxlx" })],
		});

		expect(result.rawResults).toHaveLength(1);
		expect(server.calls).not.toBeEmpty();
		expect(fetch).toHaveBeenCalledWith(
			expect.stringContaining(
				`${server.baseUrl}/cloud/v2/universes/123/places/456/versions/1/luau-execution-session-tasks`,
			),
			expect.anything(),
		);
	});
});
