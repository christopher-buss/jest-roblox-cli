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
			buildFunctionMode(hljs, comments),
			// Numbers
			hljs.C_NUMBER_MODE,
			hljs.APOS_STRING_MODE,
			// Double quote strings
			hljs.QUOTE_STRING_MODE,
			...buildStringModes(longBrackets),
		],
		keywords: buildKeywords(hljs),
	};
}

// A `function` definition: the (optionally dotted / colon-qualified) name, then
// the parameter list, which ends the mode at the closing paren. Comments are
// allowed both inside the parameter list and around it.
function buildFunctionMode(hljs: HLJSApi, comments: Array<Mode>): Mode {
	return {
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
	};
}

// The two Luau-specific string forms, in match order: long bracket `[[...]]`
// (nesting through the caller's own long-bracket mode) and backtick strings
// with `{...}` interpolation.
function buildStringModes(longBrackets: Mode): Array<Mode> {
	return [
		{
			begin: OPENING_LONG_BRACKET,
			contains: [longBrackets],
			end: CLOSING_LONG_BRACKET,
			relevance: 5,
			scope: "string",
		},
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
	];
}

function buildKeywords(hljs: HLJSApi): NonNullable<Language["keywords"]> {
	return {
		$pattern: hljs.UNDERSCORE_IDENT_RE,
		built_in: BUILT_IN,
		keyword: KEYWORD,
		literal: "true false nil",
	};
}
