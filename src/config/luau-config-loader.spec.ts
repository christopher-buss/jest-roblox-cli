import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
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
	it("should preserve a nonempty record for normal schema validation", () => {
		expect.assertions(1);

		const { filePath, fileSystem } = seedConfig(
			'return { testMatch = { pattern = "**/*.spec" } }',
		);

		expect(loadLuauConfig(filePath, fileSystem)).toStrictEqual({
			testMatch: { pattern: "**/*.spec" },
		});
	});

	it("should use empty tables for lists according to the config schema", () => {
		expect.assertions(1);

		const { filePath, fileSystem } = seedConfig(`return {
			luauRoots = {},
			workspace = { packages = {}, exclude = {} },
			test = {
				testPathIgnorePatterns = {},
				snapshotFormat = {},
				testEnvironmentOptions = { include = {} },
				typecheck = { include = {}, exclude = {} },
				projects = { { test = { include = {}, setupFiles = {} } }, "src/other" },
			},
		}`);

		expect(loadLuauConfig(filePath, fileSystem)).toStrictEqual({
			luauRoots: [],
			test: {
				projects: [{ test: { include: [], setupFiles: [] } }, "src/other"],
				snapshotFormat: {},
				testEnvironmentOptions: { include: {} },
				testPathIgnorePatterns: [],
				typecheck: { exclude: [], include: [] },
			},
			workspace: { exclude: [], packages: [] },
		});
	});

	it("should normalize empty lists in a flat project config", () => {
		expect.assertions(1);

		const { filePath, fileSystem } = seedConfig(
			'return { displayName = "project", include = {}, typecheck = { exclude = {} } }',
		);

		expect(loadLuauConfig(filePath, fileSystem)).toStrictEqual({
			displayName: "project",
			include: [],
			typecheck: { exclude: [] },
		});
	});

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

	it("should separate every parser error in the contextual message", () => {
		expect.assertions(1);

		const { filePath, fileSystem } = seedConfig("return { foo =, bar = }");

		expect(() => loadLuauConfig(filePath, fileSystem)).toThrowWithMessage(
			Error,
			"Failed to evaluate Luau config /project/jest.config.luau: Expected identifier when parsing expression, got ','; Expected identifier when parsing expression, got '}'",
		);
	});

	it("should name the file and line of syntax it cannot read", () => {
		expect.assertions(1);

		const { filePath, fileSystem } = seedConfig(
			'return {\n\tdisplayName = "a",\n\ttestTimeout = getTimeout(),\n}',
		);

		expect(() => loadLuauConfig(filePath, fileSystem)).toThrowWithMessage(
			Error,
			"Luau config /project/jest.config.luau:3 holds a function call, which a plain-data Luau config cannot hold. Use only literals, tables, `::` casts and defineConfig(...).",
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

		expect(findLuauConfigFile({ cwd: "/cwd", directoryOrFile: "project", fileSystem })).toMatch(
			/jest\.config\.luau$/,
		);
	});

	it("should return undefined when jest.config.luau does not exist", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(
			findLuauConfigFile({ cwd: "/cwd", directoryOrFile: "project", fileSystem }),
		).toBeUndefined();
	});
});

describe("loadLuauConfig lute integration", () => {
	it("should preserve string-valued config fields end-to-end", () => {
		expect.assertions(1);

		const filePath = path.resolve("config-fixture/jest.config.luau");
		const source = `return {
	displayName = "luau-integration",
	testMatch = { "**/*.spec.luau" },
}
`;

		const { fileSystem } = createMemoryFileSystem({ [filePath]: source });
		const result = loadLuauConfig(filePath, fileSystem);

		expect(result).toStrictEqual({
			displayName: "luau-integration",
			testMatch: ["**/*.spec.luau"],
		});
	});
});
