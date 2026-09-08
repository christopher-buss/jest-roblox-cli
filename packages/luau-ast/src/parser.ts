import assert from "node:assert";

import type { AstStatBlock, LuauSpan } from "./ast.ts";
import { materializeCst } from "./cst-materialize.ts";
import type { CstParseResult } from "./cst-materialize.ts";
import { createWasmRuntime, DEFECT_MARKER, PARSE_ERROR_MARKER } from "./wasm-runtime.ts";

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

export interface CstParseOptions {
	/** Names the file in a defect message. */
	fileName: string;
	source: string;
}

/** In-process Luau parser. Load once via {@link loadLuauParser}. */
export interface LuauParser {
	parse: (source: string) => ParseResult;
	/**
	 * Parse into the lossless concrete syntax tree: tokens carry their text
	 * and trivia, and printing an unedited tree reproduces the source byte
	 * for byte. A serializer defect comes back as an error, not a throw.
	 */
	parseCst: (options: CstParseOptions) => CstParseResult;
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
			parseCst({ fileName, source }) {
				const raw = runtime.parseToCstJson(source);
				if (raw.startsWith(PARSE_ERROR_MARKER)) {
					return { errors: decodeErrors(raw), ok: false };
				}

				// A defect names the file once, here, whether the serializer
				// or the gap detector found it.
				const result = raw.startsWith(DEFECT_MARKER)
					? { errors: [raw.slice(DEFECT_MARKER.length)], ok: false as const }
					: materializeCst({ json: raw, source });
				return result.ok
					? result
					: { errors: result.errors.map((error) => `${fileName}: ${error}`), ok: false };
			},
		};
	}

	return cachedParser;
}

function decodeErrors(raw: string): Array<string> {
	return raw
		.slice(PARSE_ERROR_MARKER.length)
		.split("\n")
		.filter((line) => line.length > 0);
}

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
	if (raw.startsWith(PARSE_ERROR_MARKER)) {
		return { errors: decodeErrors(raw), ok: false };
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
