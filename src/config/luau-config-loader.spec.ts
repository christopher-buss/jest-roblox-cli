import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { findLuauConfigFile, loadLuauConfig } from "./luau-config-loader.ts";

interface SeededConfig {
	filePath: string;
	fileSystem: FileSystem;
}

/**
 * A volume holding one Luau config, and the path it landed at.
 *
 * @param source - The config's Luau source.
 * @param filePath - Where it lands.
 */
function seedConfig(source: string, filePath = "/project/jest.config.luau"): SeededConfig {
	return { filePath, fileSystem: createMemoryFileSystem({ [filePath]: source }).fileSystem };
}

describe(loadLuauConfig, () => {
	it("should evaluate the config's return table", () => {
		expect.assertions(1);

		const { filePath, fileSystem } = seedConfig(
			['return {\n\ttestMatch = { "**/*.spec.luau" },', "\tverbose = true,\n}"].join("\n"),
		);

		expect(loadLuauConfig(filePath, fileSystem)).toStrictEqual({
			testMatch: ["**/*.spec.luau"],
			verbose: true,
		});
	});

	it("should throw a contextual error when the config does not parse", () => {
		expect.assertions(1);

		const { filePath, fileSystem } = seedConfig("return { = }");

		expect(() => loadLuauConfig(filePath, fileSystem)).toThrowWithMessage(
			Error,
			/Failed to evaluate Luau config/,
		);
	});

	it("should throw when config returns a non-table value", () => {
		expect.assertions(1);

		const { filePath, fileSystem } = seedConfig("return 42");

		expect(() => loadLuauConfig(filePath, fileSystem)).toThrowWithMessage(
			Error,
			/must return a table/,
		);
	});

	it("should throw when config returns a list rather than a record", () => {
		expect.assertions(1);

		const { filePath, fileSystem } = seedConfig('return { "a", "b" }');

		expect(() => loadLuauConfig(filePath, fileSystem)).toThrowWithMessage(
			Error,
			/must return a table/,
		);
	});

	it("should throw when the config file does not exist", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(() => loadLuauConfig("/project/jest.config.luau", fileSystem)).toThrow(/ENOENT/);
	});
});

describe(findLuauConfigFile, () => {
	it("should return resolved path when jest.config.luau exists", () => {
		expect.assertions(1);

		const { fileSystem } = seedConfig("return {}", "/cwd/project/jest.config.luau");

		expect(findLuauConfigFile("project", "/cwd", fileSystem)).toMatch(/jest\.config\.luau$/);
	});

	it("should return undefined when jest.config.luau does not exist", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(findLuauConfigFile("project", "/cwd", fileSystem)).toBeUndefined();
	});
});
