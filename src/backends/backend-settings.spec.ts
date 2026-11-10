import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import type { BackendSettingsRequest } from "./backend-settings.ts";
import { isStudioDiscoverable, resolveBackendSettings } from "./backend-settings.ts";

const STUDIO_EXECUTABLE = "Studio/RobloxStudioBeta.exe";

type BackendConfig = BackendSettingsRequest["config"];

/** A developer's own Studio path would otherwise decide auto. */
function stubNoStudioPath(): void {
	vi.stubEnv("JEST_ROBLOX_STUDIO_PATH", undefined);
}

function stubNoCredentials(): void {
	for (const prefix of ["ROBLOX_", "JEST_ROBLOX_"]) {
		vi.stubEnv(`${prefix}OPEN_CLOUD_API_KEY`, undefined);
		vi.stubEnv(`${prefix}UNIVERSE_ID`, undefined);
		vi.stubEnv(`${prefix}PLACE_ID`, undefined);
	}
}

function makeConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
	return { backend: "studio-cli", port: 3001, ...overrides };
}

function resolveKind(
	config: Pick<BackendConfig, "backend" | "studioPath">,
	isStudioInstalled: () => boolean,
): string {
	return resolveBackendSettings({
		cli: { apiKey: "key", placeId: "place", universeId: "universe" },
		config: makeConfig(config),
		isStudioInstalled,
	}).kind;
}

describe(isStudioDiscoverable, () => {
	it("should find Studio where discovery finds an executable", () => {
		expect.assertions(1);

		expect(isStudioDiscoverable(() => STUDIO_EXECUTABLE)).toBeTrue();
	});

	it("should not find Studio where discovery throws", () => {
		expect.assertions(1);

		expect(
			isStudioDiscoverable(() => {
				throw new Error("Roblox Studio not found.");
			}),
		).toBeFalse();
	});

	it("should not look for Studio while discovery is off", () => {
		expect.assertions(2);

		const discover = vi.fn<() => string>(() => STUDIO_EXECUTABLE);

		expect(isStudioDiscoverable(discover, () => false)).toBeFalse();
		expect(discover).not.toHaveBeenCalled();
	});

	it("should reject an unknown JEST_ROBLOX_STUDIO_DISCOVERY value", () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_STUDIO_DISCOVERY", "true");

		expect(() => {
			return isStudioDiscoverable(() => {
				throw new Error("Roblox Studio not found.");
			});
		}).toThrowWithMessage(
			Error,
			'JEST_ROBLOX_STUDIO_DISCOVERY must be "on" or "off" (was "true")',
		);
	});
});

describe("auto backend", () => {
	it("should select studio-cli when Studio is installed", () => {
		expect.assertions(1);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(resolveKind({ backend: "auto" }, () => true)).toBe("studio-cli");
	});

	it("should select open-cloud when Studio is not installed", () => {
		expect.assertions(1);

		stubNoStudioPath();
		vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(resolveKind({ backend: "auto" }, () => false)).toBe("open-cloud");
	});

	it.for(["open-cloud", "studio", "studio-cli"] as const)(
		"should keep an explicit %s backend",
		(backend) => {
			expect.assertions(1);

			expect(resolveKind({ backend }, () => backend !== "studio-cli")).toBe(backend);
		},
	);

	it("should select studio-cli when a Studio path is configured", () => {
		// A configured path is a request for Studio: a wrong one fails at
		// launch rather than quietly running on Open Cloud.
		expect.assertions(1);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(
			resolveKind({ backend: "auto", studioPath: "missing/Studio.exe" }, () => false),
		).toBe("studio-cli");
	});

	it("should select studio-cli when the environment names a Studio path", () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_STUDIO_PATH", "missing/Studio.exe");
		vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(resolveKind({ backend: "auto" }, () => false)).toBe("studio-cli");
	});

	it("should ignore an empty Studio path in the environment", () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_STUDIO_PATH", "");
		vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(resolveKind({ backend: "auto" }, () => false)).toBe("open-cloud");
	});

	it("should name the backend it selects", () => {
		expect.assertions(1);

		stubNoStudioPath();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		resolveKind({ backend: "auto" }, () => true);
		resolveKind({ backend: "auto" }, () => false);

		expect(stderr.mock.calls).toStrictEqual([
			["Backend: studio-cli (Studio installed)\n"],
			["Backend: open-cloud (Studio not found)\n"],
		]);
	});
});

describe(resolveBackendSettings, () => {
	it("should give the attached studio backend its port", () => {
		expect.assertions(1);

		const settings = resolveBackendSettings({
			cli: {},
			config: makeConfig({ backend: "studio", port: 4000 }),
			isStudioInstalled: () => false,
		});

		expect(settings).toStrictEqual({ kind: "studio", port: 4000 });
	});

	it("should give studio-cli its config and the CLI-only headed flag", () => {
		expect.assertions(1);

		const settings = resolveBackendSettings({
			cli: { headed: true },
			config: makeConfig({
				hiddenDesktop: false,
				pluginsDirectory: "plugins",
				studioPath: STUDIO_EXECUTABLE,
			}),
			isStudioInstalled: () => false,
		});

		expect(settings).toStrictEqual({
			headed: true,
			hiddenDesktop: false,
			kind: "studio-cli",
			pluginsDirectory: "plugins",
			studioPath: STUDIO_EXECUTABLE,
		});
	});

	it("should let CLI ids beat the environment, and the environment beat config ids", () => {
		expect.assertions(1);

		stubNoCredentials();
		vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_API_KEY", "env-key");
		vi.stubEnv("JEST_ROBLOX_UNIVERSE_ID", "env-universe");

		const settings = resolveBackendSettings({
			cli: { placeId: "cli-place" },
			config: makeConfig({
				backend: "open-cloud",
				placeId: "config-place",
				universeId: "config-universe",
			}),
			isStudioInstalled: () => false,
		});

		expect(settings).toStrictEqual({
			credentials: { apiKey: "env-key", placeId: "cli-place", universeId: "env-universe" },
			kind: "open-cloud",
		});
	});
});
