import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createLuteChildProcess } from "#test/mocks/lute-child-process.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { findLuauConfigFile, loadLuauConfig } from "./luau-config-loader.ts";

const CODE_CONFIG = 'return {\n\tdisplayName = "a",\n\ttestTimeout = getTimeout(),\n}';

interface SeededConfig {
	filePath: string;
	fileSystem: FileSystem;
}

/**
 * A volume holding one Luau config, and the path it landed at.
 *
 * @param source - The config's Luau source.
 * @param filePath - Where it lands.
 * @returns The file path and a memory file system that holds the source.
 */
function seedConfig(source: string, filePath = "/project/jest.config.luau"): SeededConfig {
	return { filePath, fileSystem: createMemoryFileSystem({ [filePath]: source }).fileSystem };
}

describe(loadLuauConfig, () => {
	it("should preserve a nonempty record for normal schema validation", async () => {
		expect.assertions(1);

		const { filePath, fileSystem } = seedConfig(
			'return { testMatch = { pattern = "**/*.spec" } }',
		);

		await expect(loadLuauConfig(filePath, { fileSystem })).resolves.toStrictEqual({
			testMatch: { pattern: "**/*.spec" },
		});
	});

	it("should use empty tables for lists according to the config schema", async () => {
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

		await expect(loadLuauConfig(filePath, { fileSystem })).resolves.toStrictEqual({
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

	it("should normalize empty lists in a flat project config", async () => {
		expect.assertions(1);

		const { filePath, fileSystem } = seedConfig(
			'return { displayName = "project", include = {}, typecheck = { exclude = {} } }',
		);

		await expect(loadLuauConfig(filePath, { fileSystem })).resolves.toStrictEqual({
			displayName: "project",
			include: [],
			typecheck: { exclude: [] },
		});
	});

	it("should evaluate the config's return table", async () => {
		expect.assertions(1);

		const { filePath, fileSystem } = seedConfig(
			['return {\n\ttestMatch = { "**/*.spec.luau" },', "\tverbose = true,\n}"].join("\n"),
		);

		await expect(loadLuauConfig(filePath, { fileSystem })).resolves.toStrictEqual({
			testMatch: ["**/*.spec.luau"],
			verbose: true,
		});
	});

	it("should throw a contextual error when the config does not parse", async () => {
		expect.assertions(1);

		const { filePath, fileSystem } = seedConfig("return { = }");

		await expect(loadLuauConfig(filePath, { fileSystem })).rejects.toThrowWithMessage(
			Error,
			/Failed to evaluate Luau config/,
		);
	});

	it("should separate every parser error in the contextual message", async () => {
		expect.assertions(1);

		const { filePath, fileSystem } = seedConfig("return { foo =, bar = }");

		await expect(loadLuauConfig(filePath, { fileSystem })).rejects.toThrowWithMessage(
			Error,
			"Failed to evaluate Luau config /project/jest.config.luau: Expected identifier when parsing expression, got ','; Expected identifier when parsing expression, got '}'",
		);
	});

	it("should run a config that holds code with lute and normalize its empty lists", async () => {
		expect.assertions(1);

		const { filePath, fileSystem } = seedConfig(CODE_CONFIG);
		fileSystem.mkdirSync("/temporary");
		const childProcess = createLuteChildProcess({
			value: '{"displayName":"a","setupFiles":{},"snapshotFormat":{}}',
		});

		await expect(
			loadLuauConfig(filePath, {
				childProcess,
				environment: {},
				fileSystem,
				temporaryDirectory: "/temporary",
			}),
		).resolves.toStrictEqual({ displayName: "a", setupFiles: [], snapshotFormat: {} });
	});

	it("should name the file and line of syntax it cannot read when lute is missing", async () => {
		expect.assertions(1);

		const { filePath, fileSystem } = seedConfig(CODE_CONFIG);
		const childProcess = createLuteChildProcess({
			versionError: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
		});

		await expect(
			loadLuauConfig(filePath, { childProcess, environment: {}, fileSystem }),
		).rejects.toThrow(
			`Luau config ${path.resolve(filePath)}:3 holds a function call, which needs lute to run`,
		);
	});

	it("should throw when config returns a non-table value", async () => {
		expect.assertions(1);

		const { filePath, fileSystem } = seedConfig("return 42");

		await expect(loadLuauConfig(filePath, { fileSystem })).rejects.toThrowWithMessage(
			Error,
			/must return a table/,
		);
	});

	it("should throw when config returns a list rather than a record", async () => {
		expect.assertions(1);

		const { filePath, fileSystem } = seedConfig('return { "a", "b" }');

		await expect(loadLuauConfig(filePath, { fileSystem })).rejects.toThrowWithMessage(
			Error,
			/must return a table/,
		);
	});

	it("should throw when the config file does not exist", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		await expect(loadLuauConfig("/project/jest.config.luau", { fileSystem })).rejects.toThrow(
			/ENOENT/,
		);
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
	it("should preserve string-valued config fields end-to-end", async () => {
		expect.assertions(1);

		const filePath = path.resolve("config-fixture/jest.config.luau");
		const source = `return {
	displayName = "luau-integration",
	testMatch = { "**/*.spec.luau" },
}
`;

		const { fileSystem } = createMemoryFileSystem({ [filePath]: source });
		const result = await loadLuauConfig(filePath, { fileSystem });

		expect(result).toStrictEqual({
			displayName: "luau-integration",
			testMatch: ["**/*.spec.luau"],
		});
	});
});
