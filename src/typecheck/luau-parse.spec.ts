import { describe, expect, it } from "vitest";

import { parseLuauOutput } from "./luau-parse.ts";

const FILE = "/project/sample.spec-d.luau";

describe(parseLuauOutput, () => {
	it("should strip the type function prefix and keep the continuation line", () => {
		expect.assertions(1);

		const output = [
			`${FILE}:9:11-28: (W0) TypeError: 'Eq' type function errored at runtime: [string "Eq"]:4: Expected: number`,
			"Received: string",
			"",
		].join("\n");

		expect(parseLuauOutput(output).get(FILE)).toStrictEqual([
			{
				code: "TypeError",
				column: 11,
				filePath: FILE,
				line: 9,
				message: "Expected: number\nReceived: string",
			},
		]);
	});

	it("should join a multi-line message and separate diagnostics at blank lines", () => {
		expect.assertions(1);

		const output = [
			`${FILE}:9:32-32: (W0) TypeError: Expected this to be 'Eq<string, number>', but got 'number'; `,
			"the reduced type is `never`, and `number` is not a subtype of `never`",
			"",
			`${FILE}:10:20-12:2: (W0) TypeError: Expected this to be 'number', but got 'string'`,
			"",
		].join("\n");

		expect(parseLuauOutput(output).get(FILE)).toStrictEqual([
			{
				code: "TypeError",
				column: 32,
				filePath: FILE,
				line: 9,
				message:
					"Expected this to be 'Eq<string, number>', but got 'number';\nthe reduced type is `never`, and `number` is not a subtype of `never`",
			},
			{
				code: "TypeError",
				column: 20,
				filePath: FILE,
				line: 10,
				message: "Expected this to be 'number', but got 'string'",
			},
		]);
	});

	it("should keep UTF-8 byte columns after non-ASCII source", () => {
		expect.assertions(1);

		const output = `${FILE}:13:37-39: (W0) TypeError: Expected this to be 'number', but got 'string'\n`;

		expect(parseLuauOutput(output).get(FILE)![0]!.column).toBe(37);
	});

	it("should group diagnostics by file and ignore location-less lines", () => {
		expect.assertions(1);

		const output = [
			"Failed to resolve require: @nope is not a valid alias",
			"/project/source.luau:2:23-36: (W0) TypeError: Expected this to be 'number', but got 'string'",
			"",
			`${FILE}:6:1-3: (W0) SyntaxError: Expected identifier when parsing expression, got 'end'`,
		].join("\r\n");

		expect([...parseLuauOutput(output).keys()]).toStrictEqual(["/project/source.luau", FILE]);
	});
});
