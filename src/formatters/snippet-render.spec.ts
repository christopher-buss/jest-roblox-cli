import color from "tinyrainbow";
import { describe, expect, it } from "vitest";

import type { SourceSnippet } from "../source-mapper/index.ts";
import { formatSourceSnippet } from "./snippet-render.ts";

describe(formatSourceSnippet, () => {
	it("should enable color by default", () => {
		expect.assertions(1);

		const output = formatSourceSnippet({
			filePath: "src/example.luau",
			snippet: { failureLine: 1, lines: [{ content: "return nil", num: 1 }] },
		});

		expect(output).toContain(color.cyan(" ❯ src/example.luau:1"));
	});

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
			formatSourceSnippet({
				filePath: "src/example.luau",
				language: "Luau",
				snippet,
				useColor: false,
			}),
		).toMatchSnapshot("plain");
		expect(
			formatSourceSnippet({
				filePath: "src/example.luau",
				language: "Luau",
				snippet,
				useColor: true,
			}),
		).toMatchSnapshot("colored");
	});

	it("should omit the column, caret, and language when they are unavailable", () => {
		expect.assertions(1);

		expect(
			formatSourceSnippet({
				filePath: "src/example.luau",
				snippet: { failureLine: 1, lines: [{ content: "return nil", num: 1 }] },
				useColor: false,
			}),
		).toBe(" ❯ src/example.luau:1\n\t1| return nil");
	});

	it("should advance tabs to the next tab stop", () => {
		expect.assertions(1);

		expect(
			formatSourceSnippet({
				filePath: "src/example.luau",
				snippet: { failureLine: 1, lines: [{ content: "a\tb", num: 1 }] },
				useColor: false,
			}),
		).toBe(" ❯ src/example.luau:1\n\t1| a   b");
	});
});

describe(formatSourceSnippet, () => {
	it("should format snippet with line numbers and caret", () => {
		expect.assertions(4);

		const snippet: SourceSnippet = {
			column: 10,
			failureLine: 2,
			lines: [
				{ content: "function test() {", num: 1 },
				{ content: "  expect(true).toBe(false);", num: 2 },
				{ content: "}", num: 3 },
			],
		};

		const formatted = formatSourceSnippet({ filePath: "test.ts", snippet });

		expect(formatted).toContain("❯ test.ts:2:10");
		expect(formatted).toContain("1|");
		expect(formatted).toContain("2|");
		expect(formatted).toContain("^");
	});

	it("should format snippet without column", () => {
		expect.assertions(2);

		const snippet: SourceSnippet = {
			failureLine: 1,
			lines: [{ content: "print('hello')", num: 1 }],
		};

		const formatted = formatSourceSnippet({ filePath: "test.ts", snippet });

		expect(formatted).toContain("❯ test.ts:1");
		expect(formatted).not.toContain(":1:");
	});
});

describe("expandTabs via formatSourceSnippet", () => {
	it("should expand tab characters to spaces in source snippet content", () => {
		expect.assertions(3);

		const snippet: SourceSnippet = {
			failureLine: 2,
			lines: [
				{ content: "\tconst a = 1;", num: 1 },
				{ content: "\t\texpect(a).toBe(2);", num: 2 },
			],
		};

		const formatted = formatSourceSnippet({ filePath: "file.ts", snippet, useColor: false });

		// Content tabs are expanded to spaces (gutter indent is a literal \t)
		expect(formatted).toContain("    const a = 1;");
		// Two tabs -> 8 spaces (4 + 4)
		expect(formatted).toContain("        expect(a).toBe(2);");
		expect(formatted).toContain("expect(a).toBe(2);");
	});
});

describe("complete formatter contracts", () => {
	it("should render line padding, tabs, a caret, and language exactly", () => {
		expect.assertions(1);

		const snippet: SourceSnippet = {
			column: 6,
			failureLine: 10,
			lines: [
				{ content: "\tconst count = 1;", num: 9 },
				{ content: "\t expect(count).toBe(2);", num: 10 },
			],
		};

		expect(
			formatSourceSnippet({
				filePath: "src/inventory.spec.ts",
				language: "TypeScript",
				snippet,
				useColor: false,
			}),
		).toMatchSnapshot();
	});
});
