import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { mergeCliWithConfig } from "./merge.ts";
import { DEFAULT_CONFIG } from "./schema.ts";

const stdEnvironmentMock = vi.hoisted(() => ({ isAgent: false }));

vi.mock(import("std-env"), () => stdEnvironmentMock);

describe(mergeCliWithConfig, () => {
	it("should preserve explicit falsy CLI overrides", () => {
		expect.assertions(4);

		const result = mergeCliWithConfig(
			{ outputFile: "", studioPath: "", testNamePattern: "", updateSnapshot: false },
			{
				...DEFAULT_CONFIG,
				outputFile: "results.json",
				studioPath: "Studio.exe",
				testNamePattern: "configured",
				updateSnapshot: true,
			},
		);

		expect(result.outputFile).toBe("");
		expect(result.studioPath).toBe("");
		expect(result.testNamePattern).toBe("");
		expect(result.updateSnapshot).toBeFalse();
	});

	it("should prefer explicit truthy CLI overrides", () => {
		expect.assertions(1);

		const result = mergeCliWithConfig(
			{
				gameOutput: "cli-game.log",
				outputFile: "cli-results.json",
				parallel: 3,
				studioPath: "CliStudio.exe",
				testNamePattern: "cli-pattern",
				updateSnapshot: true,
			},
			{
				...DEFAULT_CONFIG,
				gameOutput: "config-game.log",
				outputFile: "config-results.json",
				parallel: 2,
				studioPath: "ConfigStudio.exe",
				testNamePattern: "config-pattern",
				updateSnapshot: false,
			},
		);

		expect(result).toMatchObject({
			gameOutput: "cli-game.log",
			outputFile: "cli-results.json",
			parallel: 3,
			studioPath: "CliStudio.exe",
			testNamePattern: "cli-pattern",
			updateSnapshot: true,
		});
	});

	it("should add the GitHub formatter only inside GitHub Actions", () => {
		expect.assertions(2);

		const previous = process.env["GITHUB_ACTIONS"];
		onTestFinished(() => {
			process.env["GITHUB_ACTIONS"] = previous;
		});

		delete process.env["GITHUB_ACTIONS"];

		expect(mergeCliWithConfig({}, DEFAULT_CONFIG).formatters).toStrictEqual(["default"]);

		process.env["GITHUB_ACTIONS"] = "true";

		expect(mergeCliWithConfig({}, DEFAULT_CONFIG).formatters).toContain("github-actions");
	});
});
