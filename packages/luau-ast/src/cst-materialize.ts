import assert from "node:assert";

import type { LuauSpan } from "./ast.ts";
import type { CstRoot } from "./cst-statements.ts";
import { createToken } from "./cst-token.ts";
import type { Token, Trivia } from "./cst-token.ts";
import { isCstNode, isRecord } from "./cst.ts";
import { indexSourceBytes } from "./source-bytes.ts";
import type { ByteRange, SourceBytes } from "./source-bytes.ts";

export interface CstFailure {
	/** Parser errors, or one message describing a serializer defect. */
	errors: Array<string>;
	ok: false;
}

export interface CstSuccess {
	ok: true;
	root: CstRoot;
}

export type CstParseResult = CstFailure | CstSuccess;

export interface MaterializeOptions {
	/** The position-only tree from `parse_to_cst_json`. */
	json: string;
	/** The source that tree was parsed from. */
	source: string;
}

/** A token with the byte range its text came from, in source order. */
interface PlacedToken {
	range: ByteRange;
	token: Token;
}

/** What one materialization pass needs from the source. */
interface Slicer {
	bytes: SourceBytes;
	placed: Array<PlacedToken>;
}

interface ScannedTrivia {
	items: Array<Trivia>;
	/** The first run of bytes that is neither whitespace nor a comment. */
	offending?: string;
}

type Position = [number, number, number, number];

/**
 * Turn the wasm's position-only tree into a {@link CstRoot}: every token
 * position becomes a {@link Token} with its text sliced from the source, and
 * the gap between consecutive tokens becomes trivia, split Lute's way —
 * trailing on the previous token up to and including the first newline,
 * leading on the next token after it.
 *
 * The gap pass doubles as the gap detector. Two tokens may only be separated
 * by whitespace and comments; anything else means the serializer skipped or
 * misplaced a token, which is a defect reported as an error naming the two
 * tokens and the offending bytes.
 *
 * @param options - The source and the tree JSON.
 * @returns The tree, or the defect.
 */
export function materializeCst(options: MaterializeOptions): CstParseResult {
	const bytes = indexSourceBytes(options.source);
	const placed: Array<PlacedToken> = [];
	const slicer: Slicer = { bytes, placed };
	const parsed: JSONValue = JSON.parse(options.json);
	const root = materializeInPlace(parsed, "", slicer);
	assert(
		isCstNode(root) && root.type === "Root",
		"wasm wrapper returned an unrecognized CST shape",
	);

	const end = { end: bytes.byteLength, start: bytes.byteLength };
	root.eof = createToken("", bytes.rangeToSpan(end));
	placed.push({ range: end, token: root.eof });

	const defect = attachTrivia(placed, bytes);
	if (defect !== undefined) {
		return { errors: [defect], ok: false };
	}

	return { ok: true, root };
}

// The serializer only emits four-number arrays as positions.
function isPosition(value: JSONValue): value is Position {
	return Array.isArray(value) && value.length === 4 && typeof value[0] === "number";
}

function isJsonObject(value: JSONValue): value is JSONObject {
	return isRecord(value);
}

/** The serializer's 0-based position to the workspace's 1-based span. */
function toSpan(position: Position): LuauSpan {
	return {
		beginColumn: position[1] + 1,
		beginLine: position[0] + 1,
		endColumn: position[3] + 1,
		endLine: position[2] + 1,
	};
}

/**
 * Rebuild the parsed JSON in place: a position under `location` becomes a
 * span, any other position becomes a token, and containers recurse in slot
 * order so the tokens land in `placed` in source order.
 */
function materializeInPlace(
	value: JSONValue,
	key: string,
	slicer: Slicer,
): JSONValue | LuauSpan | Token {
	if (isPosition(value)) {
		const span = toSpan(value);
		if (key === "location") {
			return span;
		}

		const range = slicer.bytes.spanToRange(span);
		const token = createToken(slicer.bytes.slice(range.start, range.end), span);
		slicer.placed.push({ range, token });
		return token;
	}

	// The parsed containers are reused: each slot is overwritten with its
	// rebuilt value through a widened view of the same object.
	if (Array.isArray(value)) {
		const list: Array<unknown> = value;
		for (const [index, element] of value.entries()) {
			list[index] = materializeInPlace(element, "", slicer);
		}
	} else if (isJsonObject(value)) {
		const slots: Record<string, unknown> = value;
		for (const [slot, element] of Object.entries(value)) {
			slots[slot] = materializeInPlace(element, slot, slicer);
		}
	}

	return value;
}

/**
 * Lute's rule: everything up to and including the first newline trails the
 * previous token.
 */
function splitTrivia(items: Array<Trivia>, previous: Token | undefined, token: Token): void {
	if (previous === undefined) {
		token.leading = items;
		return;
	}

	// A newline inside a block comment does not split: the comment stays
	// whole on the side it started.
	const newline = items.findIndex(
		(item) => item.kind === "whitespace" && item.text.includes("\n"),
	);
	if (newline === -1) {
		previous.trailing = items;
		return;
	}

	previous.trailing = items.slice(0, newline + 1);
	token.leading = items.slice(newline + 1);
}

function describeToken(token: Token | undefined): string {
	if (token === undefined) {
		return "the start of the file";
	}

	const { origin } = token;
	return `token ${JSON.stringify(token.text)} at ${String(origin.beginLine)}:${String(origin.beginColumn)}`;
}

/**
 * Slice every inter-token gap into trivia and hand it to the tokens on
 * either side.
 *
 * @returns The first defect found, if any.
 */
function attachTrivia(placed: Array<PlacedToken>, bytes: SourceBytes): string | undefined {
	let previous: Token | undefined;
	let previousEnd = 0;
	for (const { range, token } of placed) {
		if (range.start < previousEnd) {
			return `${describeToken(token)} overlaps ${describeToken(previous)}`;
		}

		if (range.start > previousEnd) {
			const scanned = scanTrivia(bytes.slice(previousEnd, range.start));
			if (scanned.offending !== undefined) {
				return `bytes ${JSON.stringify(scanned.offending)} between ${describeToken(previous)} and ${describeToken(token)} are not whitespace or a comment`;
			}

			splitTrivia(scanned.items, previous, token);
		}

		previous = token;
		previousEnd = range.end;
	}

	return undefined;
}

const BLOCK_COMMENT_OPEN = /--\[(=*)\[/y;
/**
 * A whitespace run stops after a newline: that is where the trivia split
 * falls.
 */
const WHITESPACE = /[ \t\r\f\v]*\n|[ \t\r\f\v]+/y;
const TRIVIA_START = /[ \t\r\n\f\v]|--/g;

/** The comment at `cursor`, or `undefined` for an unterminated block. */
function scanComment(gap: string, cursor: number): Trivia | undefined {
	BLOCK_COMMENT_OPEN.lastIndex = cursor;
	const block = BLOCK_COMMENT_OPEN.exec(gap);
	if (!block) {
		const newline = gap.indexOf("\n", cursor);
		return { kind: "comment", text: gap.slice(cursor, newline === -1 ? gap.length : newline) };
	}

	// The opener is `--[`, the level's `=`s, then `[`.
	const close = `]${"=".repeat(block[0].length - 4)}]`;
	const closeIndex = gap.indexOf(close, cursor + block[0].length);
	if (closeIndex === -1) {
		return undefined;
	}

	return { kind: "blockComment", text: gap.slice(cursor, closeIndex + close.length) };
}

/** The whitespace at `cursor`, or `undefined` when there is none. */
function scanWhitespace(gap: string, cursor: number): Trivia | undefined {
	WHITESPACE.lastIndex = cursor;
	const text = WHITESPACE.exec(gap)?.[0];
	return text === undefined ? undefined : { kind: "whitespace", text };
}

/**
 * Split a gap into trivia items.
 *
 * @param gap - The bytes between two tokens.
 * @returns The items, and the first offending run if the gap is not all trivia.
 */
function scanTrivia(gap: string): ScannedTrivia {
	const items: Array<Trivia> = [];
	let cursor = 0;
	while (cursor < gap.length) {
		const item = gap.startsWith("--", cursor)
			? scanComment(gap, cursor)
			: scanWhitespace(gap, cursor);
		if (item === undefined) {
			TRIVIA_START.lastIndex = cursor;
			const stop = TRIVIA_START.exec(gap)?.index ?? gap.length;
			return { items, offending: gap.slice(cursor, stop <= cursor ? gap.length : stop) };
		}

		items.push(item);
		cursor += item.text.length;
	}

	return { items };
}
