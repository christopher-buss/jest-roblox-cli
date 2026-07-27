import { describe, expect, it, vi } from "vitest";

import { resolveCredentials } from "./credentials.ts";

const ENV_KEYS = [
	"ROBLOX_OPEN_CLOUD_API_KEY",
	"ROBLOX_UNIVERSE_ID",
	"ROBLOX_PLACE_ID",
	"JEST_ROBLOX_OPEN_CLOUD_API_KEY",
	"JEST_ROBLOX_UNIVERSE_ID",
	"JEST_ROBLOX_PLACE_ID",
] as const;

function clearAllEnvironment(): void {
	for (const key of ENV_KEYS) {
		vi.stubEnv(key, undefined);
	}
}

describe(resolveCredentials, () => {
	describe("returns credentials when source is present", () => {
		it("should return credentials from overrides when all three are provided", () => {
			expect.assertions(1);

			clearAllEnvironment();

			const credentials = resolveCredentials({
				overrides: { apiKey: "key", placeId: "456", universeId: "123" },
			});

			expect(credentials).toStrictEqual({ apiKey: "key", placeId: "456", universeId: "123" });
		});

		it("should return credentials from JEST_ROBLOX_ env when envPrefix is set", () => {
			expect.assertions(1);

			clearAllEnvironment();
			vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_API_KEY", "jest-key");
			vi.stubEnv("JEST_ROBLOX_UNIVERSE_ID", "j123");
			vi.stubEnv("JEST_ROBLOX_PLACE_ID", "j456");

			const credentials = resolveCredentials({ envPrefix: "JEST_" });

			expect(credentials).toStrictEqual({
				apiKey: "jest-key",
				placeId: "j456",
				universeId: "j123",
			});
		});

		it("should return credentials from canonical ROBLOX_ env without envPrefix", () => {
			expect.assertions(1);

			clearAllEnvironment();
			vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "canonical-key");
			vi.stubEnv("ROBLOX_UNIVERSE_ID", "c123");
			vi.stubEnv("ROBLOX_PLACE_ID", "c456");

			const credentials = resolveCredentials();

			expect(credentials).toStrictEqual({
				apiKey: "canonical-key",
				placeId: "c456",
				universeId: "c123",
			});
		});

		it("should fall through to canonical ROBLOX_ env when envPrefix vars are unset", () => {
			expect.assertions(1);

			clearAllEnvironment();
			vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "canonical-key");
			vi.stubEnv("ROBLOX_UNIVERSE_ID", "c123");
			vi.stubEnv("ROBLOX_PLACE_ID", "c456");

			const credentials = resolveCredentials({ envPrefix: "JEST_" });

			expect(credentials).toStrictEqual({
				apiKey: "canonical-key",
				placeId: "c456",
				universeId: "c123",
			});
		});

		it("should pull universeId/placeId from defaults and apiKey from env", () => {
			expect.assertions(1);

			clearAllEnvironment();
			vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "canonical-key");

			const credentials = resolveCredentials({
				defaults: { placeId: "d456", universeId: "d123" },
			});

			expect(credentials).toStrictEqual({
				apiKey: "canonical-key",
				placeId: "d456",
				universeId: "d123",
			});
		});
	});

	describe("precedence", () => {
		it("should prefer overrides.apiKey over both env vars", () => {
			expect.assertions(1);

			clearAllEnvironment();
			vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_API_KEY", "jest-key");
			vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "canonical-key");
			vi.stubEnv("ROBLOX_UNIVERSE_ID", "123");
			vi.stubEnv("ROBLOX_PLACE_ID", "456");

			const credentials = resolveCredentials({
				envPrefix: "JEST_",
				overrides: { apiKey: "override-key" },
			});

			expect(credentials.apiKey).toBe("override-key");
		});

		it("should prefer JEST_ROBLOX_ env over canonical ROBLOX_ env", () => {
			expect.assertions(1);

			clearAllEnvironment();
			vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_API_KEY", "jest-key");
			vi.stubEnv("JEST_ROBLOX_UNIVERSE_ID", "j123");
			vi.stubEnv("JEST_ROBLOX_PLACE_ID", "j456");
			vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "canonical-key");
			vi.stubEnv("ROBLOX_UNIVERSE_ID", "c123");
			vi.stubEnv("ROBLOX_PLACE_ID", "c456");

			const credentials = resolveCredentials({ envPrefix: "JEST_" });

			expect(credentials).toStrictEqual({
				apiKey: "jest-key",
				placeId: "j456",
				universeId: "j123",
			});
		});

		it("should prefer ROBLOX_ env over defaults", () => {
			expect.assertions(1);

			clearAllEnvironment();
			vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "canonical-key");
			vi.stubEnv("ROBLOX_UNIVERSE_ID", "c123");

			const credentials = resolveCredentials({
				defaults: { placeId: "d456", universeId: "d123" },
			});

			expect(credentials.universeId).toBe("c123");
		});

		it("should resolve mixed sources independently per field", () => {
			expect.assertions(1);

			clearAllEnvironment();
			vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "canonical-key");

			const credentials = resolveCredentials({
				defaults: { placeId: "d456" },
				overrides: { universeId: "o123" },
			});

			expect(credentials).toStrictEqual({
				apiKey: "canonical-key",
				placeId: "d456",
				universeId: "o123",
			});
		});
	});

	describe("empty-string treated as missing", () => {
		it("should fall through when overrides.apiKey is empty string", () => {
			expect.assertions(1);

			clearAllEnvironment();
			vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "canonical-key");
			vi.stubEnv("ROBLOX_UNIVERSE_ID", "123");
			vi.stubEnv("ROBLOX_PLACE_ID", "456");

			const credentials = resolveCredentials({ overrides: { apiKey: "" } });

			expect(credentials.apiKey).toBe("canonical-key");
		});

		it("should fall through when ROBLOX_ env is empty string", () => {
			expect.assertions(1);

			clearAllEnvironment();
			vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "");
			vi.stubEnv("ROBLOX_UNIVERSE_ID", "");
			vi.stubEnv("ROBLOX_PLACE_ID", "");

			expect(() => {
				return resolveCredentials({
					defaults: { placeId: "d456", universeId: "d123" },
				});
			}).toThrow(/Missing: apiKey/);
		});

		it("should treat defaults empty string as missing", () => {
			expect.assertions(1);

			clearAllEnvironment();
			vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "canonical-key");

			expect(() => resolveCredentials({ defaults: { placeId: "", universeId: "" } })).toThrow(
				/Missing: universeId, placeId/,
			);
		});

		it("should treat whitespace-only values as empty", () => {
			expect.assertions(1);

			clearAllEnvironment();
			vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", " ".repeat(3));
			vi.stubEnv("ROBLOX_UNIVERSE_ID", "\t\n");
			vi.stubEnv("ROBLOX_PLACE_ID", " ");

			expect(() => resolveCredentials()).toThrow(/Missing: apiKey, universeId, placeId/);
		});

		it("should trim whitespace around resolved values", () => {
			expect.assertions(1);

			clearAllEnvironment();
			vi.stubEnv("ROBLOX_OPEN_CLOUD_API_KEY", "  canonical-key  ");
			vi.stubEnv("ROBLOX_UNIVERSE_ID", "  123  ");
			vi.stubEnv("ROBLOX_PLACE_ID", "  456  ");

			const credentials = resolveCredentials();

			expect(credentials).toStrictEqual({
				apiKey: "canonical-key",
				placeId: "456",
				universeId: "123",
			});
		});
	});

	describe("error format", () => {
		it("should throw when no source provides any credential", () => {
			expect.assertions(1);

			clearAllEnvironment();

			expect(() => resolveCredentials()).toThrow(/credentials are required/);
		});

		it("should list all three missing fields in error", () => {
			expect.assertions(2);

			clearAllEnvironment();

			expect(() => resolveCredentials()).toThrow(/Missing: apiKey, universeId, placeId/);
			expect(() => resolveCredentials()).toThrow(
				/ROBLOX_OPEN_CLOUD_API_KEY, ROBLOX_UNIVERSE_ID, ROBLOX_PLACE_ID/,
			);
		});

		it("should list only apiKey when other two are provided via defaults", () => {
			expect.assertions(2);

			clearAllEnvironment();

			expect(() => {
				return resolveCredentials({ defaults: { placeId: "456", universeId: "123" } });
			}).toThrow(/Missing: apiKey\./);
			expect(() => {
				return resolveCredentials({ defaults: { placeId: "456", universeId: "123" } });
			}).not.toThrow(/UNIVERSE_ID|PLACE_ID/);
		});

		it("should mention JEST_ROBLOX_ alternates when envPrefix is set", () => {
			expect.assertions(1);

			clearAllEnvironment();

			expect(() => resolveCredentials({ envPrefix: "JEST_" })).toThrow(
				/ROBLOX_OPEN_CLOUD_API_KEY \(or JEST_ROBLOX_OPEN_CLOUD_API_KEY\)/,
			);
		});

		it("should omit JEST_ROBLOX_ alternates when envPrefix is unset", () => {
			expect.assertions(1);

			clearAllEnvironment();

			expect(() => resolveCredentials()).not.toThrow(/JEST_ROBLOX_/);
		});

		it("should not reference caller-specific concepts", () => {
			expect.assertions(2);

			clearAllEnvironment();

			expect(() => resolveCredentials()).not.toThrow(/--apiKey|--universeId|--placeId/);
			expect(() => resolveCredentials()).not.toThrow(/jest\.config|CLI flag/);
		});
	});

	describe("envPrefix gating", () => {
		it("should ignore JEST_ROBLOX_ env when envPrefix is unset", () => {
			expect.assertions(1);

			clearAllEnvironment();
			vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_API_KEY", "jest-key");
			vi.stubEnv("JEST_ROBLOX_UNIVERSE_ID", "j123");
			vi.stubEnv("JEST_ROBLOX_PLACE_ID", "j456");

			expect(() => resolveCredentials()).toThrow(/Missing: apiKey, universeId, placeId/);
		});
	});
});
