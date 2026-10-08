import assert from "node:assert";

import type { AstStatBlock, LuauSpan } from "./ast-types.ts";
import { constructExpression, constructStatements } from "./cst-construct.ts";
import { materializeCst } from "./cst-materialize.ts";
import type { CstParseResult } from "./cst-materialize.ts";
import type { CstBlock, CstExpr } from "./cst.ts";
import { createWasmRuntime, DEFECT_MARKER, PARSE_ERROR_MARKER } from "./wasm-runtime.ts";
import type { WasmRuntime } from "./wasm-runtime.ts";

/** A comment's span; the encoder gives no text, only where it sits. */
export interface CommentSpan {
	/** The source region, with one-based lines and UTF-8 byte columns. */
	location: LuauSpan;
	/** The discriminator identifying this variant. */
	type: "BlockComment" | "Comment";
}

/** Parser diagnostics for a source that could not be parsed. */
export interface ParseFailure {
	/** Parser error messages, one per reported error. */
	errors: Array<string>;
	/** Whether the parse or compilation succeeded. */
	ok: false;
}

/** The normalized AST and comment spans from a successful parse. */
export interface ParseSuccess {
	/** Comment positions in source order. */
	comments: Array<CommentSpan>;
	/** Whether the parse or compilation succeeded. */
	ok: true;
	/** The normalized root node of the parsed source. */
	root: AstStatBlock;
}

/** The normalized AST or the parser diagnostics. */
export type ParseResult = ParseFailure | ParseSuccess;

/** The source and diagnostic filename for a lossless parse. */
export interface CstParseOptions {
	/** Names the file in a defect message. */
	fileName: string;
	/** The Luau source passed to the backend. */
	source: string;
}

/** In-process Luau parser. Load once via {@link loadLuauParser}. */
export interface LuauParser {
	/**
	 * Parse one expression into a subtree ready to splice over a node. Its
	 * tokens carry no origin. Throws: a snippet is authored by the caller,
	 * so a snippet that does not parse is a defect there.
	 */
	constructExpression: (snippet: string) => CstExpr;
	/** Parse a statement list into a block ready to splice over a statement. */
	constructStatements: (snippet: string) => CstBlock;
	/** Parse source into a normalized AST or parser diagnostics. */
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
 * @param runtime - The backend for an uncached instance; omit it to use the shared wasm instance.
 * @returns The shared parser or an uncached instance over the supplied runtime.
 */
export function loadLuauParser(runtime?: WasmRuntime): LuauParser {
	if (runtime !== undefined) {
		return createLuauParser(runtime);
	}

	cachedParser ??= createLuauParser(createWasmRuntime());
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
 * @param json - The raw serializer JSON to rewrite.
 * @returns Valid JSON retaining the original numeric values.
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

/**
 * Brand the root shape emitted by the vendored parser wrapper.
 * @param value - The value reached in the parsed tree.
 * @returns Whether the payload carries the expected root discriminator and comments list.
 */
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

/**
 * Decode parser payloads through the supplied runtime.
 *
 * @param runtime - The parser backend for this instance.
 * @returns An independent parser over the backend.
 */
function createLuauParser(runtime: WasmRuntime): LuauParser {
	function parseCst({ fileName, source }: CstParseOptions): CstParseResult {
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
	}

	return {
		constructExpression: (snippet) => constructExpression(parseCst, snippet),
		constructStatements: (snippet) => constructStatements(parseCst, snippet),
		parse(source) {
			return decodeResult(runtime.parseToJson(source));
		},
		parseCst,
	};
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
 * @param node - The subtree or container to inspect.
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
