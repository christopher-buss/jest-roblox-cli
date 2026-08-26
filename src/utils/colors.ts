// Token colors adapted from vitest
// https://github.com/vitest-dev/vitest/blob/main/packages/vitest/src/node/reporters/renderers/colors.ts
// MIT License - Copyright (c) 2021-Present VoidZero Inc. and Vitest contributors

import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import assert from "node:assert";
import * as path from "node:path";
import color from "tinyrainbow";

import { luauGrammar } from "../highlighter/luau-grammar.ts";
import { normalizeWindowsPath } from "./normalize-windows-path.ts";

// Register languages with highlight.js
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

export function highlightCode(id: string, source: string): string {
	const extension = extname(id);

	if (LUAU_SUPPORTED_EXTS.has(extension)) {
		return highlightLuau(source);
	}

	if (TS_SUPPORTED_EXTS.has(extension)) {
		return highlightTypeScript(source);
	}

	return source;
}

function extname(filePath: string): string {
	return path.posix.extname(normalizeWindowsPath(filePath));
}

// Map highlight.js CSS classes to terminal colors
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
	// Process nested spans from inside out by repeatedly replacing
	let result = html;
	let previous: string;
	do {
		previous = result;
		result = result.replace(
			/<span class="([^"]+)">([^<]*)<\/span>/g,
			(_, cssClasses, content) => {
				// Multi-class spans (e.g., "hljs-title function_") use first
				// class
				const primaryClass = String(cssClasses).split(" ", 1).join();
				const text = String(content);
				const colorFunc = HLJS_CLASS_TO_COLOR.get(primaryClass);
				return colorFunc?.(text) ?? text;
			},
		);
	} while (result !== previous);

	// One pass, so an entity the source itself wrote cannot be decoded a
	// second time: '&amp;lt;' has to come back out as '&lt;', not '<'.
	return result.replace(HTML_ENTITY_REGEX, (entity) => {
		const char = HTML_ENTITY_TO_CHAR.get(entity);
		assert(char !== undefined, "regex only matches mapped entities");
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
