import assert from "node:assert/strict";

import type { LuauSpan } from "./ast-types.ts";
import type { CstRoot } from "./cst-statement-types.ts";
import { createToken } from "./cst-token.ts";
import type { Token, Trivia } from "./cst-token.ts";
import { isCstNode } from "./cst.ts";
import { indexSourceBytes } from "./source-bytes.ts";
import type { ByteRange, SourceBytes } from "./source-bytes.ts";

/** A rejected CST parse or materialization defect. */
export interface CstFailure {
	/** Parser errors, or one message describing a serializer defect. */
	errors: Array<string>;
	/** Whether lossless parsing and materialization succeeded. */
	ok: false;
}

/** A lossless tree materialized from the parser output. */
export interface CstSuccess {
	/** Whether lossless parsing and materialization succeeded. */
	ok: true;
	/** The normalized root node of the parsed source. */
	root: CstRoot;
}

/** The lossless tree or errors returned by CST parsing. */
export type CstParseResult = CstFailure | CstSuccess;

/** The serializer payload paired with the source it describes. */
export interface MaterializeOptions {
	/** The position-only tree from `parse_to_cst_json`. */
	json: string;
	/** The source that tree was parsed from. */
	source: string;
}

interface PlacedToken {
	range: ByteRange;
	token: Token;
}

interface Slicer {
	bytes: SourceBytes;
	placed: Array<PlacedToken>;
}

interface ScannedTrivia {
	items: Array<Trivia>;
	offending?: string;
}

type Position = [number, number, number, number];

/**
 * Turn the wasm's position-only tree into a {@link CstRoot}: every token
 * position becomes a {@link Token} with its text sliced from the source, and
 * the gap between consecutive tokens becomes trivia, split Lute's way:
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
	const parsed = JSON.parse(options.json);
	const root = materializeInPlace(parsed, { key: undefined, slicer });
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

function isPosition(value: JSONValue): value is Position {
	return (
		Array.isArray(value) &&
		value.length === 4 &&
		value.every((coordinate) => typeof coordinate === "number")
	);
}

function toSpan(position: Position): LuauSpan {
	return {
		beginColumn: position[1] + 1,
		beginLine: position[0] + 1,
		endColumn: position[3] + 1,
		endLine: position[2] + 1,
	};
}

function materializeInPlace(
	value: JSONValue,
	{ key, slicer }: { key: string | undefined; slicer: Slicer },
): JSONValue | LuauSpan | Token {
	if (key === "location") {
		assert(isPosition(value), "wasm wrapper returned an invalid CST location");
	}

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
			list[index] = materializeInPlace(element, { key: undefined, slicer });
		}
	} else if (value !== null && typeof value === "object") {
		const slots: Record<string, unknown> = value;
		for (const [slot, element] of Object.entries(value)) {
			slots[slot] = materializeInPlace(element, { key: slot, slicer });
		}
	}

	return value;
}

function splitTrivia(
	items: Array<Trivia>,
	{ previous, token }: { previous: Token | undefined; token: Token },
): void {
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

function describeToken(placed: PlacedToken | undefined, bytes: SourceBytes): string {
	if (placed === undefined) {
		return "the start of the file";
	}

	const origin = bytes.rangeToSpan(placed.range);
	return `token ${JSON.stringify(placed.token.text)} at ${String(origin.beginLine)}:${String(origin.beginColumn)}`;
}

function attachTrivia(placed: Array<PlacedToken>, bytes: SourceBytes): string | undefined {
	let previous: PlacedToken | undefined;
	let previousEnd = 0;
	for (const current of placed) {
		const { range, token } = current;
		if (range.start < previousEnd) {
			return `${describeToken(current, bytes)} overlaps ${describeToken(previous, bytes)}`;
		}

		const scanned = scanTrivia(bytes.slice(previousEnd, range.start));
		if (scanned.offending !== undefined) {
			return `bytes ${JSON.stringify(scanned.offending)} between ${describeToken(previous, bytes)} and ${describeToken(current, bytes)} are not whitespace or a comment`;
		}

		splitTrivia(scanned.items, { previous: previous?.token, token });

		previous = current;
		previousEnd = range.end;
	}

	return undefined;
}

const BLOCK_COMMENT_OPEN = /--\[(=*)\[/y;
const WHITESPACE = /[ \t\r\f\v]*\n|[ \t\r\f\v]+/y;
const TRIVIA_START = /[ \t\r\n\f\v]|--/g;

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

function scanWhitespace(gap: string, cursor: number): Trivia | undefined {
	WHITESPACE.lastIndex = cursor;
	const text = WHITESPACE.exec(gap)?.[0];
	return text === undefined ? undefined : { kind: "whitespace", text };
}

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
