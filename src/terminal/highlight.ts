// Token colors adapted from vitest
// https://github.com/vitest-dev/vitest/blob/main/packages/vitest/src/node/reporters/renderers/colors.ts
// MIT License - Copyright (c) 2021-Present VoidZero Inc. and Vitest contributors

import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import assert from "node:assert";
import * as path from "node:path";
import color from "tinyrainbow";

import { luauGrammar } from "./luau-grammar.ts";

hljs.registerLanguage("luau", luauGrammar);
hljs.registerLanguage("typescript", typescript);

const TS_SUPPORTED_EXTS = new Set(
	["js", "ts"].flatMap((lang) => [
		`.${lang}`,
		`.m${lang}`,
		`.c${lang}`,
		`.${lang}x`,
		`.m${lang}x`,
		`.c${lang}x`,
	]),
);

const LUAU_SUPPORTED_EXTS = new Set([".lua", ".luau"]);

/**
 * Syntax-highlight source for the terminal, picking the grammar by extension.
 * @param id - The file path, used for its extension.
 * @param source - The source text.
 * @returns The highlighted text, or the source unchanged for other files.
 */
export function highlightCode(id: string, source: string): string {
	const extension = path.win32.extname(id);

	if (LUAU_SUPPORTED_EXTS.has(extension)) {
		return highlightLuau(source);
	}

	if (TS_SUPPORTED_EXTS.has(extension)) {
		return highlightTypeScript(source);
	}

	return source;
}

const HLJS_CLASS_TO_COLOR = new Map([
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
]);

// Every entity highlight.js escapes, from its escapeHTML
const HTML_ENTITY_TO_CHAR = new Map([
	["&#x27;", "'"],
	["&amp;", "&"],
	["&gt;", ">"],
	["&lt;", "<"],
	["&quot;", '"'],
]);

const HTML_ENTITY_REGEX = /&(?:#x27|amp|gt|lt|quot);/g;

function convertHljsToAnsi(html: string): string {
	let result = html;
	let previous: string;
	do {
		previous = result;
		result = result.replace(
			/<span class="([^"]+)">([^<]*)<\/span>/g,
			(...[, cssClasses, content]: Array<number | string>) => {
				const primaryClass = String(cssClasses).split(" ", 1).join();
				const text = String(content);
				const colorFunc = HLJS_CLASS_TO_COLOR.get(primaryClass);
				return colorFunc?.(text) ?? text;
			},
		);
	} while (result !== previous);

	// One pass, or '&amp;lt;' would decode twice to '<'.
	return result.replace(HTML_ENTITY_REGEX, (entity) => {
		const char = HTML_ENTITY_TO_CHAR.get(entity);
		assert(char !== undefined);
		return char;
	});
}

function highlightLuau(source: string): string {
	const result = hljs.highlight(source, { language: "luau" });
	return convertHljsToAnsi(result.value);
}

function highlightTypeScript(source: string): string {
	const result = hljs.highlight(source, { language: "typescript" });
	const ansi = convertHljsToAnsi(result.value);
	// highlight.js doesn't emit classes for arrow operators
	const arrow = color.yellow("=>");
	return ansi.replace(/=>/g, () => arrow);
}
