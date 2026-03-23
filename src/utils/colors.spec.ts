import hljs from "highlight.js/lib/core";
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

			const spy = vi.spyOn(hljs, "highlight").mockReturnValueOnce({
				_emitter: {} as never,
				_top: {} as never,
				illegal: false,
				language: "typescript",
				relevance: 10,
				value: '<span class="hljs-unknown-class">hello</span>',
			});

			const result = highlightCode("file.ts", "hello");

			expect(result).toBe("hello");

			spy.mockRestore();
		});
	});
});
