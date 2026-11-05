import { describe, expect, it, vi } from "vitest";

import { resolveOpenCloudBaseUrl, resolveRunnerOptions } from "./open-cloud-environment.ts";

describe(resolveOpenCloudBaseUrl, () => {
	it("should return undefined when the env var is unset", () => {
		expect.assertions(1);

		expect(resolveOpenCloudBaseUrl()).toBeUndefined();
	});

	it.for([
		["", undefined],
		[" ".repeat(3), undefined],
		["///", ""],
		["https://apis.example.test", "https://apis.example.test"],
		["  https://apis.example.test/path///  ", "https://apis.example.test/path"],
	] as const)("should normalize %j to %j", ([raw, expected]) => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_BASE_URL", raw);

		expect(resolveOpenCloudBaseUrl()).toBe(expected);
	});
});

describe("the retry override", () => {
	it("should return undefined when the env var is unset", () => {
		expect.assertions(1);

		expect(resolveRunnerOptions().maxRetries).toBeUndefined();
	});

	it("should return undefined for an empty/whitespace value", () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_OCALE_MAX_RETRIES", " ".repeat(3));

		expect(resolveRunnerOptions().maxRetries).toBeUndefined();
	});

	it("should parse a valid non-negative integer", () => {
		expect.assertions(2);

		vi.stubEnv("JEST_ROBLOX_OCALE_MAX_RETRIES", "8");

		expect(resolveRunnerOptions().maxRetries).toBe(8);

		vi.stubEnv("JEST_ROBLOX_OCALE_MAX_RETRIES", "0");

		expect(resolveRunnerOptions().maxRetries).toBe(0);
	});

	it("should return undefined for a partial-numeric value (parseInt trap)", () => {
		expect.assertions(1);

		// Number.parseInt("8abc") would truncate to 8; Number() rejects it.
		vi.stubEnv("JEST_ROBLOX_OCALE_MAX_RETRIES", "8abc");

		expect(resolveRunnerOptions().maxRetries).toBeUndefined();
	});

	it("should return undefined for a decimal value", () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_OCALE_MAX_RETRIES", "8.5");

		expect(resolveRunnerOptions().maxRetries).toBeUndefined();
	});

	it("should return undefined for a negative value", () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_OCALE_MAX_RETRIES", "-1");

		expect(resolveRunnerOptions().maxRetries).toBeUndefined();
	});
});

describe(resolveRunnerOptions, () => {
	it("should carry the base URL and retry overrides", () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_OPEN_CLOUD_BASE_URL", "https://apis.example.test/");
		vi.stubEnv("JEST_ROBLOX_OCALE_MAX_RETRIES", "8");

		expect(resolveRunnerOptions()).toStrictEqual({
			baseUrl: "https://apis.example.test",
			maxRetries: 8,
		});
	});
});
