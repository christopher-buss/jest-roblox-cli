// Luau language grammar for highlight.js. Based on highlightjs-luau with fixes
// for proper string handling.
// cspell:ignore newindex metatable idiv getfenv setfenv apos metatags

import type { HLJSApi, Language, Mode } from "highlight.js";

const OPENING_LONG_BRACKET = "\\[=*\\[";
const CLOSING_LONG_BRACKET = "\\]=*\\]";

// prettier-ignore
const BUILT_IN =
	// Lua metatags and globals
	"_G _VERSION __index __newindex __mode __call __metatable __tostring __len " +
	"__gc __add __sub __mul __div __mod __pow __concat __unm __eq __lt __le assert " +
	"__idiv __iter newproxy rawlen " +
	// Standard library
	"collectgarbage error getfenv getmetatable ipairs loadstring " +
	"next pairs pcall print rawequal rawget rawset require select setfenv " +
	"setmetatable tonumber tostring type unpack xpcall self " +
	"coroutine resume yield status wrap create running " +
	"debug traceback " +
	"math log max acos huge ldexp pi cos tanh pow deg tan cosh sinh random randomseed frexp ceil floor rad abs sqrt modf asin min mod fmod log10 atan2 exp sin atan " +
	"os date difftime time clock " +
	"string sub upper len rep find match char gmatch reverse byte format gsub lower " +
	"table insert getn foreachi maxn foreach concat sort remove " +
	// Roblox globals
	"game workspace script plugin Instance Enum " +
	// Jest/testing globals (for test file highlighting)
	"describe it expect test beforeAll afterAll beforeEach afterEach jest toBe toEqual toContain toThrow toHaveBeenCalled";

const KEYWORD =
	"and break continue do else elseif end for function if in local not or repeat return then until while type export";

export function luauGrammar(hljs: HLJSApi): Language {
	const longBrackets = {
		begin: OPENING_LONG_BRACKET,
		contains: ["self"],
		end: CLOSING_LONG_BRACKET,
	} satisfies Mode;

	const comments: Array<Mode> = [
		hljs.COMMENT(`--(?!${OPENING_LONG_BRACKET})`, "$"),
		hljs.COMMENT(`--${OPENING_LONG_BRACKET}`, CLOSING_LONG_BRACKET, {
			contains: [longBrackets],
			relevance: 10,
		}),
	];

	return {
		name: "Luau",
		contains: [
			...comments,
			// Function definitions
			{
				beginKeywords: "function",
				contains: [
					hljs.inherit(hljs.TITLE_MODE, {
						begin: "([_a-zA-Z]\\w*\\.)*([_a-zA-Z]\\w*:)?[_a-zA-Z]\\w*",
					}),
					{
						begin: "\\(",
						contains: comments,
						endsWithParent: true,
						scope: "params",
					},
					...comments,
				],
				end: "\\)",
				scope: "function",
			},
			// Numbers
			hljs.C_NUMBER_MODE,
			hljs.APOS_STRING_MODE,
			// Double quote strings
			hljs.QUOTE_STRING_MODE,
			// Long bracket strings [[...]]
			{
				begin: OPENING_LONG_BRACKET,
				contains: [longBrackets],
				end: CLOSING_LONG_BRACKET,
				relevance: 5,
				scope: "string",
			},
			// Backtick strings with interpolation (Luau-specific)
			{
				begin: "`",
				contains: [
					{
						begin: "\\{",
						end: "\\}",
						scope: "subst",
					},
				],
				end: "`",
				scope: "string",
			},
		],
		keywords: {
			$pattern: hljs.UNDERSCORE_IDENT_RE,
			built_in: BUILT_IN,
			keyword: KEYWORD,
			literal: "true false nil",
		},
	};
}
