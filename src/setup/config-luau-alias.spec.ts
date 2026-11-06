import { describe, expect, it } from "vitest";

import { addConfigLuauAlias } from "./config-luau-alias.ts";

const ALIAS = { name: "jest-roblox", value: "~/.jest-roblox/typedefs/1.2.3" };

function edit(source: string) {
	return addConfigLuauAlias({ alias: ALIAS, fileName: ".config.luau", source });
}

describe(addConfigLuauAlias, () => {
	it("should append the alias to a multi-line aliases table and keep its comments", () => {
		expect.assertions(1);

		const source = [
			"-- project settings",
			"return {",
			"\tluau = {",
			'\t\tlanguagemode = "strict", -- strict everywhere',
			"\t\taliases = {",
			'\t\t\tshared = "./shared", -- shared code',
			"\t\t},",
			"\t},",
			"}",
			"",
		].join("\n");

		expect(edit(source)).toStrictEqual({
			kind: "edited",
			source: [
				"-- project settings",
				"return {",
				"\tluau = {",
				'\t\tlanguagemode = "strict", -- strict everywhere',
				"\t\taliases = {",
				'\t\t\tshared = "./shared", -- shared code',
				'\t\t\t["jest-roblox"] = "~/.jest-roblox/typedefs/1.2.3",',
				"\t\t},",
				"\t},",
				"}",
				"",
			].join("\n"),
		});
	});

	it("should add a separator after a last entry that has none", () => {
		expect.assertions(1);

		const source =
			'return {\n\tluau = {\n\t\taliases = {\n\t\t\tshared = "./shared" -- c\n\t\t},\n\t},\n}\n';

		expect(edit(source)).toStrictEqual({
			kind: "edited",
			source: 'return {\n\tluau = {\n\t\taliases = {\n\t\t\tshared = "./shared", -- c\n\t\t\t["jest-roblox"] = "~/.jest-roblox/typedefs/1.2.3"\n\t\t},\n\t},\n}\n',
		});
	});

	it("should keep CRLF line endings", () => {
		expect.assertions(1);

		const source =
			'return {\r\n\tluau = {\r\n\t\taliases = {\r\n\t\t\tshared = "./shared",\r\n\t\t},\r\n\t},\r\n}\r\n';

		expect(edit(source)).toStrictEqual({
			kind: "edited",
			source: 'return {\r\n\tluau = {\r\n\t\taliases = {\r\n\t\t\tshared = "./shared",\r\n\t\t\t["jest-roblox"] = "~/.jest-roblox/typedefs/1.2.3",\r\n\t\t},\r\n\t},\r\n}\r\n',
		});
	});

	it("should append to a single-line aliases table", () => {
		expect.assertions(1);

		expect(edit('return { luau = { aliases = { shared = "./shared" } } }\n')).toStrictEqual({
			kind: "edited",
			source: 'return { luau = { aliases = { shared = "./shared", ["jest-roblox"] = "~/.jest-roblox/typedefs/1.2.3" } } }\n',
		});
	});

	it("should fill an empty aliases table", () => {
		expect.assertions(1);

		expect(edit("return { luau = { aliases = {} } }\n")).toStrictEqual({
			kind: "edited",
			source: 'return { luau = { aliases = { ["jest-roblox"] = "~/.jest-roblox/typedefs/1.2.3" } } }\n',
		});
	});

	it("should fill an empty aliases table that holds a space", () => {
		expect.assertions(1);

		expect(edit("return { luau = { aliases = { } } }\n")).toStrictEqual({
			kind: "edited",
			source: 'return { luau = { aliases = { ["jest-roblox"] = "~/.jest-roblox/typedefs/1.2.3" } } }\n',
		});
	});

	it("should not indent the entry when the last entry has no indentation", () => {
		expect.assertions(1);

		expect(edit('return { luau = { aliases = {shared = "./shared",\n} } }\n')).toStrictEqual({
			kind: "edited",
			source: 'return { luau = { aliases = {shared = "./shared",\n["jest-roblox"] = "~/.jest-roblox/typedefs/1.2.3",\n} } }\n',
		});
	});

	it("should read the return after other statements", () => {
		expect.assertions(1);

		expect(edit("local unused = 1\nreturn { luau = { aliases = {} } }\n")).toStrictEqual({
			kind: "edited",
			source: 'local unused = 1\nreturn { luau = { aliases = { ["jest-roblox"] = "~/.jest-roblox/typedefs/1.2.3" } } }\n',
		});
	});

	it("should keep a block comment after the last single-line entry once", () => {
		expect.assertions(1);

		expect(
			edit('return { luau = { aliases = { shared = "./shared" --[[c]] } } }\n'),
		).toStrictEqual({
			kind: "edited",
			source: 'return { luau = { aliases = { shared = "./shared", --[[c]] ["jest-roblox"] = "~/.jest-roblox/typedefs/1.2.3" } } }\n',
		});
	});

	it("should not copy a blank line above the last entry", () => {
		expect.assertions(1);

		const source = 'return {\nluau = {\naliases = {\na = "./a",\n\nb = "./b",\n},\n},\n}\n';

		expect(edit(source)).toStrictEqual({
			kind: "edited",
			source: 'return {\nluau = {\naliases = {\na = "./a",\n\nb = "./b",\n["jest-roblox"] = "~/.jest-roblox/typedefs/1.2.3",\n},\n},\n}\n',
		});
	});

	it("should fill an empty multi-line aliases table after a comment", () => {
		expect.assertions(1);

		expect(
			edit("return {\n\tluau = {\n\t\taliases = { -- none yet\n\t\t},\n\t},\n}\n"),
		).toStrictEqual({
			kind: "edited",
			source: 'return {\n\tluau = {\n\t\taliases = { -- none yet\n\t\t\t["jest-roblox"] = "~/.jest-roblox/typedefs/1.2.3",\n\t\t},\n\t},\n}\n',
		});
	});

	it("should fill an empty multi-line aliases table", () => {
		expect.assertions(1);

		expect(edit("return {\n\tluau = {\n\t\taliases = {\n\t\t},\n\t},\n}\n")).toStrictEqual({
			kind: "edited",
			source: 'return {\n\tluau = {\n\t\taliases = {\n\t\t\t["jest-roblox"] = "~/.jest-roblox/typedefs/1.2.3",\n\t\t},\n\t},\n}\n',
		});
	});

	it("should add an aliases table to a luau table without one", () => {
		expect.assertions(1);

		expect(edit('return {\n\tluau = {\n\t\tlanguagemode = "strict",\n\t},\n}\n')).toStrictEqual(
			{
				kind: "edited",
				source: 'return {\n\tluau = {\n\t\tlanguagemode = "strict",\n\t\taliases = { ["jest-roblox"] = "~/.jest-roblox/typedefs/1.2.3" },\n\t},\n}\n',
			},
		);
	});

	it("should add a luau table to a config without one", () => {
		expect.assertions(1);

		expect(edit("return {}\n")).toStrictEqual({
			kind: "edited",
			source: 'return { luau = { aliases = { ["jest-roblox"] = "~/.jest-roblox/typedefs/1.2.3" } } }\n',
		});
	});

	it("should point an existing alias at the new folder", () => {
		expect.assertions(1);

		const source =
			'return {\n\tluau = {\n\t\t["aliases"] = {\n\t\t\t["Jest-Roblox"] = "~/.jest-roblox/typedefs/1.0.0", -- types\n\t\t},\n\t},\n}\n';

		expect(edit(source)).toStrictEqual({
			kind: "edited",
			source: 'return {\n\tluau = {\n\t\t["aliases"] = {\n\t\t\t["Jest-Roblox"] = "~/.jest-roblox/typedefs/1.2.3", -- types\n\t\t},\n\t},\n}\n',
		});
	});

	it("should skip entries whose key is not a string literal", () => {
		expect.assertions(1);

		expect(
			edit('return { "positional", [1] = true, luau = { aliases = {} } }\n'),
		).toStrictEqual({
			kind: "edited",
			source: 'return { "positional", [1] = true, luau = { aliases = { ["jest-roblox"] = "~/.jest-roblox/typedefs/1.2.3" } } }\n',
		});
	});

	it.for<[string, string]>([
		["the returned value is a local", "local config = {}\nreturn config\n"],
		["luau is a call", "return { luau = make() }\n"],
		["aliases is a local", "local aliases = {}\nreturn { luau = { aliases = aliases } }\n"],
		[
			"the alias value is computed",
			'return { luau = { aliases = { ["jest-roblox"] = home .. "/x" } } }\n',
		],
		["the file returns nothing", "local x = 1\n"],
	])("should report a computed table when %s", ([, source]) => {
		expect.assertions(1);

		expect(edit(source)).toStrictEqual({ kind: "computed" });
	});

	it("should name the file when it does not parse", () => {
		expect.assertions(1);

		expect(() => edit("local = 1\nlocal = 2\nreturn {}")).toThrow(
			"Failed to parse .config.luau: Expected identifier when parsing variable name, got '='; Expected identifier when parsing variable name, got '='",
		);
	});
});
