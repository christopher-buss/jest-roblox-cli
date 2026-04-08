/* cspell:words ocale */
import process from "node:process";
import { describe, expect, it } from "vitest";

import { createOcaleRunner, createOcaleRunnerFromEnvironment, createStudioRunner } from "./auto.ts";
import { OcaleRunner } from "./ocale-runner.ts";
import { StudioRunner } from "./studio-runner.ts";

function withEnvironmentBackup(callback: () => void): void {
	const backup: Record<string, string | undefined> = {
		ROBLOX_OPEN_CLOUD_API_KEY: process.env["ROBLOX_OPEN_CLOUD_API_KEY"],
		ROBLOX_PLACE_ID: process.env["ROBLOX_PLACE_ID"],
		ROBLOX_UNIVERSE_ID: process.env["ROBLOX_UNIVERSE_ID"],
	};

	try {
		callback();
	} finally {
		for (const [key, value] of Object.entries(backup)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

describe(createOcaleRunner, () => {
	it("should create an OcaleRunner instance", () => {
		expect.assertions(1);

		const runner = createOcaleRunner({
			apiKey: "key",
			placeId: "456",
			universeId: "123",
		});

		expect(runner).toBeInstanceOf(OcaleRunner);
	});
});

describe(createStudioRunner, () => {
	it("should create a StudioRunner instance", () => {
		expect.assertions(1);

		const runner = createStudioRunner({ port: 3000 });

		expect(runner).toBeInstanceOf(StudioRunner);
	});
});

describe(createOcaleRunnerFromEnvironment, () => {
	it("should create runner from environment variables", () => {
		expect.assertions(1);

		withEnvironmentBackup(() => {
			process.env["ROBLOX_OPEN_CLOUD_API_KEY"] = "key";
			process.env["ROBLOX_UNIVERSE_ID"] = "123";
			process.env["ROBLOX_PLACE_ID"] = "456";

			const runner = createOcaleRunnerFromEnvironment();

			expect(runner).toBeInstanceOf(OcaleRunner);
		});
	});

	it("should throw when ROBLOX_OPEN_CLOUD_API_KEY is missing", () => {
		expect.assertions(1);

		withEnvironmentBackup(() => {
			delete process.env["ROBLOX_OPEN_CLOUD_API_KEY"];
			delete process.env["ROBLOX_UNIVERSE_ID"];
			delete process.env["ROBLOX_PLACE_ID"];

			expect(() => createOcaleRunnerFromEnvironment()).toThrow(
				"ROBLOX_OPEN_CLOUD_API_KEY environment variable is required",
			);
		});
	});

	it("should throw when ROBLOX_UNIVERSE_ID is missing", () => {
		expect.assertions(1);

		withEnvironmentBackup(() => {
			process.env["ROBLOX_OPEN_CLOUD_API_KEY"] = "key";
			delete process.env["ROBLOX_UNIVERSE_ID"];
			delete process.env["ROBLOX_PLACE_ID"];

			expect(() => createOcaleRunnerFromEnvironment()).toThrow(
				"ROBLOX_UNIVERSE_ID environment variable is required",
			);
		});
	});

	it("should throw when ROBLOX_PLACE_ID is missing", () => {
		expect.assertions(1);

		withEnvironmentBackup(() => {
			process.env["ROBLOX_OPEN_CLOUD_API_KEY"] = "key";
			process.env["ROBLOX_UNIVERSE_ID"] = "123";
			delete process.env["ROBLOX_PLACE_ID"];

			expect(() => createOcaleRunnerFromEnvironment()).toThrow(
				"ROBLOX_PLACE_ID environment variable is required",
			);
		});
	});

	it("should throw when ROBLOX_OPEN_CLOUD_API_KEY is empty string", () => {
		expect.assertions(1);

		withEnvironmentBackup(() => {
			process.env["ROBLOX_OPEN_CLOUD_API_KEY"] = "";
			process.env["ROBLOX_UNIVERSE_ID"] = "123";
			process.env["ROBLOX_PLACE_ID"] = "456";

			expect(() => createOcaleRunnerFromEnvironment()).toThrow(
				"ROBLOX_OPEN_CLOUD_API_KEY environment variable is required",
			);
		});
	});
});
