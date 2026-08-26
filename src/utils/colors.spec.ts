import { fromPartial } from "@total-typescript/shoehorn";

import hljs from "highlight.js/lib/core";
import { stripVTControlCharacters } from "node:util";
import color from "tinyrainbow";
import { describe, expect, it, vi } from "vitest";

import { highlightCode } from "./colors.ts";

describe(highlightCode, () => {
	describe("language detection", () => {
		it("should return source unchanged for unknown extensions", () => {
			expect.assertions(1);

			const source = "hello world";

			expect(highlightCode("file.txt", source)).toBe(source);
		});

		it("should return source unchanged when path has no extension", () => {
			expect.assertions(1);

			const source = "hello world";

			expect(highlightCode("Makefile", source)).toBe(source);
		});

		it("should return source unchanged for '..' path", () => {
			expect.assertions(1);

			const source = "hello world";

			expect(highlightCode("..", source)).toBe(source);
		});

		it("should not invoke a highlighter for an unknown extension", () => {
			expect.assertions(2);

			const highlight = vi.spyOn(hljs, "highlight");
			const source = "local value = 1";

			expect(highlightCode("file.txt", source)).toBe(source);
			expect(highlight).not.toHaveBeenCalled();
		});

		it.for([
			["file.lua", "luau"],
			["file.ts", "typescript"],
		] as const)("should select the exact grammar for %s", ([fileName, language]) => {
			expect.assertions(1);

			const highlight = vi
				.spyOn(hljs, "highlight")
				.mockReturnValueOnce(fromPartial({ value: "source" }));

			highlightCode(fileName, "source");

			expect(highlight).toHaveBeenCalledExactlyOnceWith("source", { language });
		});
	});

	describe("typescript highlighting", () => {
		/* cspell:disable */
		const tsExtensions = [
			".ts",
			".tsx",
			".js",
			".jsx",
			".mts",
			".cts",
			".mjs",
			".cjs",
			".mtsx",
			".ctsx",
			".mjsx",
			".cjsx",
		];
		/* cspell:enable */

		it.for(tsExtensions)("should highlight %s files", (extension) => {
			expect.assertions(1);

			const source = "const x = 1;";
			const result = highlightCode(`file${extension}`, source);

			expect(result).not.toBe(source);
		});

		it("should color-wrap arrow operators in TypeScript", () => {
			expect.assertions(2);

			const source = "() => 1";
			const result = highlightCode("file.ts", source);

			// The => should be wrapped with ANSI color codes (yellow), not plain
			expect(result).toContain("=>");
			// Result should have ANSI escape sequences around =>
			expect(result).not.toBe(source);
		});

		it.for<[string, (text: string) => string]>([
			["hljs-attr", color.blue],
			["hljs-built_in", color.blue],
			["hljs-comment", color.gray],
			["hljs-function", color.blue],
			["hljs-keyword", color.magenta],
			["hljs-literal", color.blue],
			["hljs-meta", color.gray],
			["hljs-number", color.blue],
			["hljs-operator", color.yellow],
			["hljs-params", color.white],
			["hljs-punctuation", color.yellow],
			["hljs-regexp", color.cyan],
			["hljs-string", color.green],
			["hljs-subst", color.cyan],
			["hljs-title", color.blue],
			["hljs-type", color.yellow],
			["hljs-variable", color.white],
		])("should map the %s token class to its terminal color", ([cssClass, style]) => {
			expect.assertions(1);

			vi.spyOn(hljs, "highlight").mockReturnValueOnce(
				fromPartial({
					value: `<span class="${cssClass}">token</span>`,
				}),
			);

			expect(highlightCode("file.ts", "token")).toBe(style("token"));
		});

		it("should preserve nested token styles", () => {
			expect.assertions(1);

			vi.spyOn(hljs, "highlight").mockReturnValueOnce(
				fromPartial({
					value: '<span class="hljs-keyword"><span class="hljs-string">token</span></span>',
				}),
			);

			expect(highlightCode("file.ts", "token")).toBe(color.magenta(color.green("token")));
		});
	});

	describe("luau highlighting", () => {
		it("should highlight .luau files", () => {
			expect.assertions(1);

			const source = "local x = 1";
			const result = highlightCode("file.luau", source);

			expect(result).not.toBe(source);
		});

		it("should highlight .lua files", () => {
			expect.assertions(1);

			const source = "local x = 1";
			const result = highlightCode("file.lua", source);

			expect(result).not.toBe(source);
		});
	});

	describe("html entity decoding", () => {
		it("should decode HTML entities in highlighted output", () => {
			expect.assertions(4);

			// Use code that will produce HTML entities via highlight.js
			const source = 'if x < 1 then print("hello") end';
			const result = highlightCode("file.luau", source);

			// Should not contain HTML entities in final output
			expect(result).not.toContain("&lt;");
			expect(result).not.toContain("&gt;");
			expect(result).not.toContain("&amp;");
			expect(result).not.toContain("&quot;");
		});

		it("should decode each entity to its exact source character", () => {
			expect.assertions(1);

			vi.spyOn(hljs, "highlight").mockReturnValueOnce(
				fromPartial({ value: "&#x27;&amp;&gt;&lt;&quot;" }),
			);

			expect(highlightCode("file.ts", "ignored")).toBe("'&><\"");
		});

		it("should decode single quotes", () => {
			expect.assertions(1);

			const source = "local s = 'hello'";
			const result = highlightCode("file.luau", source);

			expect(stripVTControlCharacters(result)).toBe(source);
		});

		it("should keep entities that the source itself contains", () => {
			expect.assertions(1);

			// highlight.js escapes the ampersand of each entity, so a second
			// round of decoding would turn these back into '<' and '>'.
			const source = 'local s = "&lt;tag&gt;"';
			const result = highlightCode("file.luau", source);

			expect(stripVTControlCharacters(result)).toBe(source);
		});
	});

	describe("windows path handling", () => {
		it("should detect extension from Windows-style paths", () => {
			expect.assertions(1);

			const source = "const x = 1;";
			const result = highlightCode("D:\\src\\file.ts", source);

			expect(result).not.toBe(source);
		});
	});

	describe("unmapped hljs class fallback", () => {
		it("should return plain text when hljs emits an unknown CSS class", () => {
			expect.assertions(1);

			vi.spyOn(hljs, "highlight").mockReturnValueOnce(
				fromPartial({
					illegal: false,
					language: "typescript",
					relevance: 10,
					value: '<span class="hljs-unknown-class">hello</span>',
				}),
			);

			const result = highlightCode("file.ts", "hello");

			expect(result).toBe("hello");
		});
	});
});
