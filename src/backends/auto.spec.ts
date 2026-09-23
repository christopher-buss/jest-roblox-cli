import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import {
	getLastCreatedServer,
	MockWebSocketServer,
	mockWebSocketServerFactory as webSocketServerFactory,
} from "../../test/mocks/mock-web-socket-server.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import { isStudioDiscoverable, resolveAutoBackend, resolveBackendAsync } from "./auto.ts";
import { OpenCloudBackend } from "./open-cloud.ts";
import { StudioCliBackend } from "./studio-cli.ts";
import { StudioBackend } from "./studio.ts";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...DEFAULT_CONFIG, ...overrides };
}

function makeCli(overrides: Partial<CliOptions> = {}): CliOptions {
	return overrides;
}

function stubNoCredentials(): void {
	vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", undefined);
	vi.stubEnv("ROBLOX_UNIVERSE_ID", undefined);
	vi.stubEnv("ROBLOX_PLACE_ID", undefined);
	vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_API_KEY", undefined);
	vi.stubEnv("JEST_ROBLOX_UNIVERSE_ID", undefined);
	vi.stubEnv("JEST_ROBLOX_PLACE_ID", undefined);
}

// A developer's own Studio path would otherwise decide auto.
function stubNoStudioPath(): void {
	vi.stubEnv("JEST_ROBLOX_STUDIO_PATH", undefined);
}

function stubCredentials(): void {
	vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "test-key");
	vi.stubEnv("ROBLOX_UNIVERSE_ID", "123");
	vi.stubEnv("ROBLOX_PLACE_ID", "456");
}

describe(isStudioDiscoverable, () => {
	it("should find Studio where discovery finds an executable", () => {
		expect.assertions(1);

		expect(isStudioDiscoverable(() => "C:/Studio/RobloxStudioBeta.exe")).toBeTrue();
	});

	it("should not find Studio where discovery throws", () => {
		expect.assertions(1);

		expect(
			isStudioDiscoverable(() => {
				throw new Error("Roblox Studio not found.");
			}),
		).toBeFalse();
	});
});

describe(resolveAutoBackend, () => {
	it("should select studio-cli when Studio is installed", () => {
		expect.assertions(1);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(resolveAutoBackend({ backend: "auto" }, () => true)).toBe("studio-cli");
	});

	it("should select open-cloud when Studio is not installed", () => {
		expect.assertions(1);

		stubNoStudioPath();
		vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(resolveAutoBackend({ backend: "auto" }, () => false)).toBe("open-cloud");
	});

	it.for(["open-cloud", "studio", "studio-cli"] as const)(
		"should keep an explicit %s backend",
		(backend) => {
			expect.assertions(1);

			expect(resolveAutoBackend({ backend }, () => backend !== "studio-cli")).toBe(backend);
		},
	);

	it("should select studio-cli when a Studio path is configured", () => {
		// A configured path is a request for Studio: a wrong one fails at
		// launch rather than quietly running on Open Cloud.
		expect.assertions(1);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(
			resolveAutoBackend({ backend: "auto", studioPath: "missing/Studio.exe" }, () => false),
		).toBe("studio-cli");
	});

	it("should select studio-cli when the environment names a Studio path", () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_STUDIO_PATH", "missing/Studio.exe");
		vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(resolveAutoBackend({ backend: "auto" }, () => false)).toBe("studio-cli");
	});

	it("should ignore an empty Studio path in the environment", () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_STUDIO_PATH", "");
		vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(resolveAutoBackend({ backend: "auto" }, () => false)).toBe("open-cloud");
	});

	it("should name the backend it selects", () => {
		expect.assertions(1);

		stubNoStudioPath();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		resolveAutoBackend({ backend: "auto" }, () => true);
		resolveAutoBackend({ backend: "auto" }, () => false);

		expect(stderr.mock.calls).toStrictEqual([
			["Backend: studio-cli (Studio installed)\n"],
			["Backend: open-cloud (Studio not installed)\n"],
		]);
	});
});

describe(resolveBackendAsync, () => {
	it("should select studio-cli for auto when Studio is installed", async () => {
		expect.assertions(1);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend = await resolveBackendAsync(makeCli(), makeConfig({ backend: "auto" }), {
			isStudioInstalled: () => true,
		});

		expect(backend).toBeInstanceOf(StudioCliBackend);
	});

	it("should select open-cloud for auto when Studio is not installed", async () => {
		expect.assertions(1);

		stubNoStudioPath();
		stubCredentials();
		vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const backend = await resolveBackendAsync(makeCli(), makeConfig({ backend: "auto" }), {
			isStudioInstalled: () => false,
		});

		expect(backend).toBeInstanceOf(OpenCloudBackend);
	});

	it("should name the missing credential when auto has neither Studio nor Open Cloud", async () => {
		expect.assertions(1);

		stubNoStudioPath();
		stubNoCredentials();
		vi.spyOn(process.stderr, "write").mockReturnValue(true);

		await expect(
			resolveBackendAsync(makeCli(), makeConfig({ backend: "auto" }), {
				isStudioInstalled: () => false,
			}),
		).rejects.toThrow(/Missing:/);
	});

	it("should select open-cloud when only JEST_ROBLOX_* env vars are set", async () => {
		expect.assertions(1);

		stubNoCredentials();
		vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_API_KEY", "jest-key");
		vi.stubEnv("JEST_ROBLOX_UNIVERSE_ID", "888");
		vi.stubEnv("JEST_ROBLOX_PLACE_ID", "999");

		const backend = await resolveBackendAsync(makeCli(), makeConfig({ backend: "open-cloud" }));

		expect(backend).toBeInstanceOf(OpenCloudBackend);
	});

	it("should return studio backend for explicit studio config", async () => {
		expect.assertions(1);

		const backend = await resolveBackendAsync(makeCli(), makeConfig({ backend: "studio" }));

		expect(backend).toBeInstanceOf(StudioBackend);
	});

	it("should open an explicit studio backend's server through the server seam", async () => {
		expect.assertions(2);

		const backend = await resolveBackendAsync(
			makeCli(),
			makeConfig({ backend: "studio", timeout: 1 }),
			{ webSocketServerFactory },
		);

		await expect(backend.runTestsAsync({ jobs: [] })).rejects.toThrowWithMessage(
			Error,
			"Timed out waiting for Studio plugin connection",
		);

		expect(getLastCreatedServer()).toBeInstanceOf(MockWebSocketServer);
	});

	it("should return studio-cli backend for explicit studio-cli config", async () => {
		expect.assertions(1);

		const backend = await resolveBackendAsync(makeCli(), makeConfig({ backend: "studio-cli" }));

		expect(backend).toBeInstanceOf(StudioCliBackend);
	});

	it("should forward the configured Studio path to the studio-cli backend", async () => {
		expect.assertions(1);

		const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "jest-roblox-auto-"));
		onTestFinished(() => {
			fs.rmSync(rootDirectory, { force: true, recursive: true });
		});
		const configuredPath = path.join(rootDirectory, "configured-studio.exe");
		vi.stubEnv("JEST_ROBLOX_STUDIO_PATH", path.join(rootDirectory, "environment-studio.exe"));

		const config = makeConfig({
			backend: "studio-cli",
			collectCoverage: true,
			placeFile: path.join(rootDirectory, "place.rbxl"),
			rootDir: rootDirectory,
			studioPath: configuredPath,
		});
		const backend = await resolveBackendAsync(makeCli(), config);

		await expect(
			backend.runTestsAsync({
				jobs: [{ config, displayName: "project", testFiles: ["test.spec.ts"] }],
			}),
		).rejects.toThrowWithMessage(
			Error,
			`Roblox Studio not found at studioPath override: ${configuredPath}`,
		);
	});

	it("should accept any --parallel for studio-cli, which runs one session", async () => {
		expect.assertions(1);

		const backend = await resolveBackendAsync(
			makeCli(),
			makeConfig({ backend: "studio-cli", parallel: 3 }),
		);

		expect(backend).toBeInstanceOf(StudioCliBackend);
	});

	it("should reject --experimental-vm-parallel on the open-cloud backend", async () => {
		expect.assertions(1);

		stubCredentials();

		await expect(
			resolveBackendAsync(
				makeCli(),
				makeConfig({ backend: "open-cloud", experimentalVmParallel: 2 }),
			),
		).rejects.toThrowWithMessage(
			Error,
			"--experimental-vm-parallel is Studio-only: an Open Cloud session has no " +
				"second Luau VM to run a project in. Use --parallel to shard the run " +
				"across Open Cloud sessions instead.",
		);
	});

	it("should accept --experimental-vm-parallel on the studio backend", async () => {
		expect.assertions(1);

		const backend = await resolveBackendAsync(
			makeCli(),
			makeConfig({ backend: "studio", experimentalVmParallel: "auto" }),
		);

		expect(backend.kind).toBe("studio");
	});

	it("should reject an explicit VM count above the hosts the plugin ships", async () => {
		expect.assertions(1);

		await expect(
			resolveBackendAsync(
				makeCli(),
				makeConfig({ backend: "studio", experimentalVmParallel: 8 }),
			),
		).rejects.toThrowWithMessage(
			Error,
			"--experimental-vm-parallel 8 is more than the Studio plugin " +
				"ships 4 VM hosts. Pass at most 4, or pass the flag bare for one VM per project " +
				"up to that cap.",
		);
	});

	it("should accept a VM count equal to the host pool", async () => {
		expect.assertions(1);

		const backend = await resolveBackendAsync(
			makeCli(),
			makeConfig({ backend: "studio", experimentalVmParallel: 4 }),
		);

		expect(backend.kind).toBe("studio");
	});

	it("should return open-cloud backend for explicit open-cloud config", async () => {
		expect.assertions(1);

		stubNoCredentials();

		const backend = await resolveBackendAsync(
			makeCli({ apiKey: "test-key" }),
			makeConfig({ backend: "open-cloud", placeId: "456", universeId: "123" }),
		);

		expect(backend).toBeInstanceOf(OpenCloudBackend);
	});

	it.for([
		makeCli({ apiKey: "key" }),
		makeCli({ universeId: "123" }),
		makeCli({ placeId: "456" }),
	])("should surface the precise resolver error for a partial CLI override", async (cli) => {
		expect.assertions(1);

		stubNoCredentials();

		await expect(
			resolveBackendAsync(cli, makeConfig({ backend: "open-cloud" })),
		).rejects.toThrow(/Missing:/);
	});
});
