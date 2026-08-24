import assert from "node:assert";

import type { AstStatBlock, LuauSpan } from "./ast.ts";
import { createWasmRuntime } from "./wasm-runtime.ts";

/** A comment's span; the encoder gives no text, only where it sits. */
export interface CommentSpan {
	location: LuauSpan;
	type: "BlockComment" | "Comment";
}

export interface ParseFailure {
	/** Parser error messages, one per reported error. */
	errors: Array<string>;
	ok: false;
}

export interface ParseSuccess {
	comments: Array<CommentSpan>;
	ok: true;
	root: AstStatBlock;
}

export type ParseResult = ParseFailure | ParseSuccess;

/** In-process Luau parser. Load once via {@link loadLuauParser}. */
export interface LuauParser {
	parse: (source: string) => ParseResult;
}

let cachedParser: LuauParser | undefined;

/**
 * Instantiate the wasm build of the official Luau parser. Instantiation is
 * synchronous (the module is embedded, not fetched) and the instance is
 * cached for the process; repeat calls return the same parser.
 *
 * @returns The shared parser instance.
 */
export function loadLuauParser(): LuauParser {
	if (cachedParser === undefined) {
		const runtime = createWasmRuntime();
		cachedParser = {
			parse(source) {
				return decodeResult(runtime.parseToJson(source));
			},
		};
	}

	return cachedParser;
}

const ERROR_MARKER = "";

/**
 * The encoder prints non-finite doubles as bare `Infinity` / `-Infinity`,
 * which is invalid JSON. Rewrite each bare occurrence to `1e999` — which
 * `JSON.parse` overflows back to the same infinity, sign included — while
 * leaving occurrences inside JSON strings untouched.
 */
function sanitizeNonFinite(json: string): string {
	if (!json.includes("Infinity")) {
		return json;
	}

	let output = "";
	let segmentStart = 0;
	let isInString = false;
	for (let index = 0; index < json.length; index += 1) {
		const character = json[index];
		if (isInString) {
			if (character === "\\") {
				index += 1;
			} else if (character === '"') {
				isInString = false;
			}

			continue;
		}

		if (character === '"') {
			isInString = true;
			continue;
		}

		if (character === "I" && json.startsWith("Infinity", index)) {
			output += `${json.slice(segmentStart, index)}1e999`;
			index += "Infinity".length - 1;
			segmentStart = index + 1;
		}
	}

	return output + json.slice(segmentStart);
}

// Brands the wrapper's decoded output. The JSON comes from our own vendored
// parser (wrapper.cpp), so per-node validation would only re-check what the
// encoder just produced; the root check carries the invariant at the type
// level like mutation-tester's isAstStatBlock does.
function isRawParseOutput(
	value: JSONValue,
): value is JSONValue & { commentLocations: Array<CommentSpan>; root: AstStatBlock } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}

	const { root } = value;
	return (
		Array.isArray(value["commentLocations"]) &&
		typeof root === "object" &&
		root !== null &&
		!Array.isArray(root) &&
		root["type"] === "AstStatBlock"
	);
}

function decodeResult(raw: string): ParseResult {
	if (raw.startsWith(ERROR_MARKER)) {
		const errors = raw
			.slice(ERROR_MARKER.length)
			.split("\n")
			.filter((line) => line.length > 0);
		return { errors, ok: false };
	}

	const parsed = JSON.parse(sanitizeNonFinite(raw));
	normalizeSpans(parsed);
	assert(isRawParseOutput(parsed), "wasm wrapper returned an unrecognized JSON shape");
	return { comments: parsed.commentLocations, ok: true, root: parsed.root };
}

const SPAN_PATTERN = /^(\d+),(\d+) - (\d+),(\d+)$/;

function isRecord(value: JSONValue): value is JSONObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The encoder emits locations as 0-based `"line,col - line,col"` strings under
 * `location` and `*Location` keys. Rewrite them in place into 1-based
 * {@link LuauSpan} objects (the workspace convention the Lute-era span helpers
 * expect); the +1 keeps the exclusive end exclusive.
 */
function normalizeSpans(node: JSONValue): void {
	if (Array.isArray(node)) {
		for (const element of node) {
			normalizeSpans(element);
		}

		return;
	}

	if (!isRecord(node)) {
		return;
	}

	for (const [key, value] of Object.entries(node)) {
		if (typeof value === "string" && (key === "location" || key.endsWith("Location"))) {
			const match = SPAN_PATTERN.exec(value);
			assert(match, `unrecognized location string: ${value}`);
			node[key] = {
				beginColumn: Number(match[2]) + 1,
				beginLine: Number(match[1]) + 1,
				endColumn: Number(match[4]) + 1,
				endLine: Number(match[3]) + 1,
			} satisfies LuauSpan;

			continue;
		}

		normalizeSpans(value);
	}
}
