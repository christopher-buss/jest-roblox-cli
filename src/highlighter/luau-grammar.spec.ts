// cspell:ignore APOS

import { fromAny } from "@total-typescript/shoehorn";

import type { HLJSApi, Mode } from "highlight.js";
import { describe, expect, it } from "vitest";

import { luauGrammar } from "./luau-grammar.ts";

describe(luauGrammar, () => {
	it("should describe the complete Luau grammar", () => {
		expect.assertions(1);

		const hljs = fromAny<HLJSApi, Record<string, unknown>>({
			APOS_STRING_MODE: { scope: "apostrophe-string" },
			C_NUMBER_MODE: { scope: "number" },
			COMMENT(begin: RegExp | string, end: RegExp | string, options: Mode = {}) {
				return { ...options, begin, end, scope: "comment" };
			},
			inherit(original: Mode, overrides: Mode) {
				return { ...original, ...overrides };
			},
			QUOTE_STRING_MODE: { scope: "quote-string" },
			TITLE_MODE: { scope: "title" },
			UNDERSCORE_IDENT_RE: "identifier-pattern",
		});

		expect(luauGrammar(hljs)).toMatchSnapshot();
	});
});
