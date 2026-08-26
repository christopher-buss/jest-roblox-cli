import { describe, expect, it } from "vitest";

import type { SourceSnippet } from "../source-mapper/index.ts";
import { formatSourceSnippet, parseSourceLocation } from "./snippets.ts";

describe(formatSourceSnippet, () => {
	it("should render padding, tabs, syntax, language, and the caret exactly", () => {
		expect.assertions(2);

		const snippet: SourceSnippet = {
			column: 6,
			failureLine: 10,
			lines: [
				{ content: "\tlocal value = true", num: 9 },
				{ content: "\treturn value", num: 10 },
				{ content: "end", num: 11 },
			],
		};

		expect(
			formatSourceSnippet(snippet, "src/example.luau", {
				language: "Luau",
				useColor: false,
			}),
		).toMatchSnapshot("plain");
		expect(
			formatSourceSnippet(snippet, "src/example.luau", {
				language: "Luau",
				useColor: true,
			}),
		).toMatchSnapshot("colored");
	});

	it("should omit the column, caret, and language when they are unavailable", () => {
		expect.assertions(1);

		expect(
			formatSourceSnippet(
				{ failureLine: 1, lines: [{ content: "return nil", num: 1 }] },
				"src/example.luau",
				{ useColor: false },
			),
		).toBe(" ❯ src/example.luau:1\n\t1| return nil");
	});
});

describe(parseSourceLocation, () => {
	it("should parse supported source extensions with optional columns", () => {
		expect.assertions(1);

		expect([
			parseSourceLocation("at src/a.ts:25:12"),
			parseSourceLocation("at src/b.tsx:2"),
			parseSourceLocation("at src/c.lua:3:4"),
			parseSourceLocation("at src/d.luau:5"),
			parseSourceLocation("at src/e.js:6:7"),
		]).toStrictEqual([
			{ column: 12, line: 25, path: "src/a.ts" },
			{ column: undefined, line: 2, path: "src/b.tsx" },
			{ column: 4, line: 3, path: "src/c.lua" },
			{ column: undefined, line: 5, path: "src/d.luau" },
			undefined,
		]);
	});
});
