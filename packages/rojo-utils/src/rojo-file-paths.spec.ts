import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	convertToLuau,
	isPathDescendantOf,
	isRojoProjectFileName,
	stripRojoExtensions,
} from "./rojo-file-paths.ts";

describe(isRojoProjectFileName, () => {
	it.for<[string, boolean]>([
		["default.project.json", true],
		["a.project.json", true],
		[".project.json", false],
		["a.project-json", false],
		["a-project.json", false],
		["a.project.json.bak", false],
		["project.json", false],
	])("should classify %s", ([name, expected]) => {
		expect.assertions(1);

		expect(isRojoProjectFileName(name)).toBe(expected);
	});
});

describe(stripRojoExtensions, () => {
	it.for<[string, string]>([
		["a.luau", "a"],
		["a.server.luau", "a"],
		["a.client.luau", "a"],
		["a.other.luau", "a.other"],
		["a.server.json", "a.server"],
		["a.toml", "a"],
		["a.lua", "a.lua"],
		["plain", "plain"],
	])("should strip Rojo suffixes from %s", ([input, output]) => {
		expect.assertions(1);

		expect(stripRojoExtensions(input)).toBe(output);
	});
});

describe(convertToLuau, () => {
	it.for<[string, string]>([
		["a.lua", "a.luau"],
		["a.luau", "a.luau"],
		["a.lua.json", "a.lua.json"],
		["plain", "plain"],
	])("should normalize %s", ([input, output]) => {
		expect.assertions(1);

		expect(convertToLuau(input)).toBe(output);
	});
});

describe(isPathDescendantOf, () => {
	it("should require a containing directory or the identical path", () => {
		expect.assertions(3);

		const directory = path.resolve("root");

		expect(isPathDescendantOf(directory, directory)).toBeTrue();
		expect(isPathDescendantOf(path.join(directory, "child"), directory)).toBeTrue();
		expect(isPathDescendantOf(path.resolve("sibling"), directory)).toBeFalse();
	});
});
