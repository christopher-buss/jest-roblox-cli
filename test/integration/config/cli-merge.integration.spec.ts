import { resolveCredentials } from "@isentinel/roblox-runner";

import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { parseArgs } from "../../../src/cli.ts";
import { loadConfig } from "../../../src/config/loader.ts";
import { createFixtureSandbox } from "../../e2e/cli/helpers.ts";

const RBXTS_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/rbxts-project");
const ENV_PREFIX = "JEST_";

function writeConfigWithCredentials(
	sandbox: string,
	credentials: { placeId: string; universeId: string },
): void {
	writeFileSync(
		path.join(sandbox, "jest.config.ts"),
		`import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	placeId: "${credentials.placeId}",
	rojoProject: "default.project.json",
	test: {
		projects: [
			{
				test: {
					displayName: "rbxts-e2e",
					include: ["src/**/*.spec.ts"],
					outDir: "out",
				},
			},
		],
	},
	universeId: "${credentials.universeId}",
});
`,
	);
}

function clearCredentialEnvironment(): void {
	vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", undefined);
	vi.stubEnv("ROBLOX_UNIVERSE_ID", undefined);
	vi.stubEnv("ROBLOX_PLACE_ID", undefined);
	vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_API_KEY", undefined);
	vi.stubEnv("JEST_ROBLOX_UNIVERSE_ID", undefined);
	vi.stubEnv("JEST_ROBLOX_PLACE_ID", undefined);
}

describe("cli / jest.config.ts credential precedence", () => {
	it("should resolve universeId/placeId from jest.config.ts and apiKey from CLI", async () => {
		expect.assertions(4);

		clearCredentialEnvironment();

		const sandbox = createFixtureSandbox(RBXTS_FIXTURE);
		writeConfigWithCredentials(sandbox, { placeId: "777", universeId: "555" });

		const cli = parseArgs(["--apiKey", "cli-key"]);
		const config = await loadConfig(undefined, sandbox);

		const credentials = resolveCredentials({
			defaults: { placeId: config.placeId, universeId: config.universeId },
			envPrefix: ENV_PREFIX,
			overrides: { apiKey: cli.apiKey, placeId: cli.placeId, universeId: cli.universeId },
		});

		// CLI supplies apiKey; config supplies universeId/placeId.
		expect(credentials.apiKey).toBe("cli-key");
		expect(credentials.universeId).toBe("555");
		expect(credentials.placeId).toBe("777");

		// CLI universeId/placeId weren't passed — they fall through to config.
		expect(cli.universeId).toBeUndefined();
	});

	it("should let CLI flags override jest.config.ts values", async () => {
		expect.assertions(3);

		clearCredentialEnvironment();

		const sandbox = createFixtureSandbox(RBXTS_FIXTURE);
		writeConfigWithCredentials(sandbox, {
			placeId: "config-place",
			universeId: "config-universe",
		});

		const cli = parseArgs([
			"--apiKey",
			"cli-key",
			"--universeId",
			"override-universe",
			"--placeId",
			"override-place",
		]);
		const config = await loadConfig(undefined, sandbox);

		const credentials = resolveCredentials({
			defaults: { placeId: config.placeId, universeId: config.universeId },
			envPrefix: ENV_PREFIX,
			overrides: { apiKey: cli.apiKey, placeId: cli.placeId, universeId: cli.universeId },
		});

		// CLI overrides win over config defaults.
		expect(credentials.apiKey).toBe("cli-key");
		expect(credentials.universeId).toBe("override-universe");
		expect(credentials.placeId).toBe("override-place");
	});
});
