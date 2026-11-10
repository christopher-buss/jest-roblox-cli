import { describe, expect, it } from "vitest";

import { createPlainStyles } from "#test/mocks/format-plain-styles.ts";
import { createTaggedStyles } from "#test/mocks/format-tagged-styles.ts";
import type { SourceSnippet } from "../source-mapper/index.ts";
import type { Styles } from "../terminal/palette.ts";
import { formatSourceSnippet } from "./snippet-render.ts";

describe(formatSourceSnippet, () => {
	it("should highlight code through the palette highlighter", () => {
		expect.assertions(1);

		const output = formatSourceSnippet({
			filePath: "src/example.luau",
			snippet: { failureLine: 1, lines: [{ content: "return nil", num: 1 }] },
			styles: highlightingStyles(),
		});

		expect(output).toBe(
			"<location> ❯ src/example.luau:1</location>\n\t<lineNumber>1|</lineNumber> <hl src/example.luau>return nil</hl>",
		);
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
				styles: createPlainStyles(),
			}),
		).toMatchSnapshot("plain");
		expect(
			formatSourceSnippet({
				filePath: "src/example.luau",
				language: "Luau",
				snippet,
				styles: highlightingStyles(),
			}),
		).toMatchSnapshot("colored");
	});

	it("should omit the column, caret, and language when they are unavailable", () => {
		expect.assertions(1);

		expect(
			formatSourceSnippet({
				filePath: "src/example.luau",
				snippet: { failureLine: 1, lines: [{ content: "return nil", num: 1 }] },
				styles: createPlainStyles(),
			}),
		).toBe(" ❯ src/example.luau:1\n\t1| return nil");
	});

	it("should advance tabs to the next tab stop", () => {
		expect.assertions(1);

		expect(
			formatSourceSnippet({
				filePath: "src/example.luau",
				snippet: { failureLine: 1, lines: [{ content: "a\tb", num: 1 }] },
				styles: createPlainStyles(),
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

		const formatted = formatSourceSnippet({
			filePath: "test.ts",
			snippet,
			styles: createPlainStyles(),
		});

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

		const formatted = formatSourceSnippet({
			filePath: "test.ts",
			snippet,
			styles: createPlainStyles(),
		});

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

		const formatted = formatSourceSnippet({
			filePath: "file.ts",
			snippet,
			styles: createPlainStyles(),
		});

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
				styles: createPlainStyles(),
			}),
		).toMatchSnapshot();
	});
});

describe("formatSourceSnippet root", () => {
	it("should show the header path relative to the root", () => {
		expect.assertions(1);

		expect(
			formatSourceSnippet({
				filePath: "/ws/packages/a/src/example.luau",
				rootDir: "/ws/packages/a",
				snippet: { failureLine: 1, lines: [{ content: "return nil", num: 1 }] },
				styles: createPlainStyles(),
			}),
		).toBe(" ❯ src/example.luau:1\n\t1| return nil");
	});
});

function highlightingStyles(): Styles {
	return {
		...createTaggedStyles(),
		highlight: (filePath, code) => `<hl ${filePath}>${code}</hl>`,
	};
}
