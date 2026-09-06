import { describe, expect, it, vi } from "vitest";

import { defaultFormatters } from "./default-formatters.ts";
import { mergeCliWithConfig } from "./merge.ts";
import { DEFAULT_CONFIG } from "./schema.ts";

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

	it("should keep explicit formatters over the environment-detected defaults", () => {
		expect.assertions(2);

		expect(
			mergeCliWithConfig({ formatters: ["json"] }, DEFAULT_CONFIG).formatters,
		).toStrictEqual(["json"]);
		expect(
			mergeCliWithConfig({}, { ...DEFAULT_CONFIG, formatters: ["junit"] }).formatters,
		).toStrictEqual(["junit"]);
	});

	it("should fall back to the environment-detected formatter defaults", () => {
		expect.assertions(1);

		expect(mergeCliWithConfig({}, DEFAULT_CONFIG).formatters).toStrictEqual(
			defaultFormatters(),
		);
	});

	it("should add the GitHub formatter only inside GitHub Actions", () => {
		expect.assertions(2);

		expect(mergeCliWithConfig({}, DEFAULT_CONFIG).formatters).not.toContain("github-actions");

		vi.stubEnv("GITHUB_ACTIONS", "true");

		expect(mergeCliWithConfig({}, DEFAULT_CONFIG).formatters).toContain("github-actions");
	});
});
