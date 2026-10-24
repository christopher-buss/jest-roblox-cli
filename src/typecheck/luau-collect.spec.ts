import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

// cspell:ignore turbofish
import { collectLuauTestDefinitions, createByteLocationsIndexMap } from "./luau-collect.ts";

describe(createByteLocationsIndexMap, () => {
	it("should map UTF-8 byte columns to byte offsets", () => {
		expect.assertions(3);

		const locations = createByteLocationsIndexMap('a"é"\nb');

		expect(locations.get("1:3")).toBe(2);
		expect(locations.get("1:5")).toBe(4);
		expect(locations.get("2:2")).toBe(7);
	});
});

describe(collectLuauTestDefinitions, () => {
	it("should collect global, local, member and turbofish calls with ancestors", () => {
		expect.assertions(1);

		const source = [
			"--!strict",
			"local t = { it = function(_n: string, f: () -> ()) end }",
			"local function it(_n: string, f: () -> ()) end",
			'describe("suite", function()',
			'\tit("local", function() end)',
			'\tt.it("member", function() end)',
			'\tit<<number>>("turbofish", function() end)',
			"end)",
			'it("after", function() end)',
		].join("\n");

		const { definitions } = collectLuauTestDefinitions(source);

		expect(
			definitions.map(({ name, ancestorNames, type }) => {
				return { name, ancestorNames, type };
			}),
		).toStrictEqual([
			{ name: "suite", ancestorNames: [], type: "suite" },
			{ name: "local", ancestorNames: ["suite"], type: "test" },
			{ name: "member", ancestorNames: ["suite"], type: "test" },
			{ name: "turbofish", ancestorNames: ["suite"], type: "test" },
			{ name: "after", ancestorNames: [], type: "test" },
		]);
	});

	it("should span the call in byte offsets after non-ASCII text", () => {
		expect.assertions(1);

		const prefix = '--!strict\nlocal _s = "ü"\n';
		const call = 'it("x", function() end)';
		const source = `${prefix}${call}`;

		const [definition] = collectLuauTestDefinitions(source).definitions;

		expect(definition).toMatchObject({
			end: Buffer.byteLength(source),
			start: Buffer.byteLength(prefix),
		});
	});

	it("should skip calls without a string literal name or with another callee", () => {
		expect.assertions(1);

		const source = [
			"--!strict",
			"local name = 'n'",
			"it(name, function() end)",
			"it()",
			'print("x")',
			"local f = function() return it end",
			'f()("y")',
		].join("\n");

		expect(collectLuauTestDefinitions(source)).toStrictEqual({ definitions: [], problems: [] });
	});

	it("should report a file without --!strict", () => {
		expect.assertions(1);

		const result = collectLuauTestDefinitions('--!nonstrict\nit("x", function() end)');

		expect(result.problems).toStrictEqual([
			{ code: "StrictMode", message: expect.stringContaining("--!strict") },
		]);
	});

	it("should accept --!strict after other leading comments", () => {
		expect.assertions(1);

		const result = collectLuauTestDefinitions("-- header\n\n--!strict\nlocal _x = 1");

		expect(result.problems).toStrictEqual([]);
	});

	it("should report a file of only comments without --!strict", () => {
		expect.assertions(1);

		expect(collectLuauTestDefinitions("-- only a comment").problems).toHaveLength(1);
	});

	it("should report a file whose only --!strict follows code", () => {
		expect.assertions(1);

		const result = collectLuauTestDefinitions("local _x = 1\n--!strict");

		expect(result.problems).toHaveLength(1);
	});

	it("should report a parse failure with the parser message", () => {
		expect.assertions(2);

		const result = collectLuauTestDefinitions("--!strict\nlocal x = ");

		expect(result.definitions).toStrictEqual([]);
		expect(result.problems[0]).toMatchObject({
			code: "SyntaxError",
			message: expect.stringContaining("Expected"),
		});
	});
});
