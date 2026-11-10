import { describe, expect, it, vi } from "vitest";

import { expectedDefaultFormatters } from "#test/mocks/config-default-formatters.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { mergeCliWithConfig } from "./merge.ts";

describe(mergeCliWithConfig, () => {
	it("should preserve explicit falsy CLI overrides", () => {
		expect.assertions(5);

		const result = mergeCliWithConfig(
			{
				hiddenDesktop: false,
				outputFile: "",
				studioPath: "",
				testNamePattern: "",
				updateSnapshot: false,
			},
			{
				...createResolvedConfig(),
				hiddenDesktop: true,
				outputFile: "results.json",
				studioPath: "Studio.exe",
				testNamePattern: "configured",
				updateSnapshot: true,
			},
		);

		expect(result.hiddenDesktop).toBeFalse();
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
				...createResolvedConfig(),
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

	it("should keep the config hiddenDesktop when the CLI leaves it unset", () => {
		expect.assertions(1);

		expect(
			mergeCliWithConfig({}, { ...createResolvedConfig(), hiddenDesktop: true })
				.hiddenDesktop,
		).toBeTrue();
	});

	it("should keep explicit formatters over the environment-detected defaults", () => {
		expect.assertions(2);

		expect(
			mergeCliWithConfig({ formatters: ["json"] }, createResolvedConfig()).formatters,
		).toStrictEqual(["json"]);
		expect(
			mergeCliWithConfig({}, { ...createResolvedConfig(), formatters: ["github-actions"] })
				.formatters,
		).toStrictEqual(["github-actions"]);
	});

	it("should fall back to the environment-detected formatter defaults", () => {
		expect.assertions(1);

		expect(mergeCliWithConfig({}, createResolvedConfig()).formatters).toStrictEqual(
			expectedDefaultFormatters(),
		);
	});

	it("should add the GitHub formatter only inside GitHub Actions", () => {
		expect.assertions(2);

		expect(mergeCliWithConfig({}, createResolvedConfig()).formatters).not.toContain(
			"github-actions",
		);

		vi.stubEnv("GITHUB_ACTIONS", "true");

		expect(mergeCliWithConfig({}, createResolvedConfig()).formatters).toContain(
			"github-actions",
		);
	});
});
