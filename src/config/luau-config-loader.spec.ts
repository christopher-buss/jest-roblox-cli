import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { findLuauConfigFile, loadLuauConfig } from "./luau-config-loader.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

function seedConfig(source: string, filePath = "/project/jest.config.luau"): string {
	onTestFinished(() => {
		vol.reset();
	});
	const directory = filePath.slice(0, filePath.lastIndexOf("/"));
	vol.mkdirSync(directory, { recursive: true });
	vol.writeFileSync(filePath, source);
	return filePath;
}

describe(loadLuauConfig, () => {
	it("should evaluate the config's return table", () => {
		expect.assertions(1);

		const filePath = seedConfig(
			['return {\n\ttestMatch = { "**/*.spec.luau" },', "\tverbose = true,\n}"].join("\n"),
		);

		expect(loadLuauConfig(filePath)).toStrictEqual({
			testMatch: ["**/*.spec.luau"],
			verbose: true,
		});
	});

	it("should throw a contextual error when the config does not parse", () => {
		expect.assertions(1);

		const filePath = seedConfig("return { = }");

		expect(() => loadLuauConfig(filePath)).toThrowWithMessage(
			Error,
			/Failed to evaluate Luau config/,
		);
	});

	it("should throw when config returns a non-table value", () => {
		expect.assertions(1);

		const filePath = seedConfig("return 42");

		expect(() => loadLuauConfig(filePath)).toThrowWithMessage(Error, /must return a table/);
	});

	it("should throw when config returns a list rather than a record", () => {
		expect.assertions(1);

		const filePath = seedConfig('return { "a", "b" }');

		expect(() => loadLuauConfig(filePath)).toThrowWithMessage(Error, /must return a table/);
	});

	it("should throw when the config file does not exist", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});
		vol.mkdirSync("/project", { recursive: true });

		expect(() => loadLuauConfig("/project/jest.config.luau")).toThrow(/ENOENT/);
	});
});

describe(findLuauConfigFile, () => {
	it("should return resolved path when jest.config.luau exists", () => {
		expect.assertions(1);

		seedConfig("return {}", "/cwd/project/jest.config.luau");

		const result = findLuauConfigFile("project", "/cwd");

		expect(result).toMatch(/jest\.config\.luau$/);
	});

	it("should return undefined when jest.config.luau does not exist", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});
		vol.mkdirSync("/cwd/project", { recursive: true });

		expect(findLuauConfigFile("project", "/cwd")).toBeUndefined();
	});
});
