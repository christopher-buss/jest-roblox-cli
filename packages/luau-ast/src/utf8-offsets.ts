import assert from "node:assert";
import { Buffer } from "node:buffer";

/** A text's byte offsets resolved against its UTF-16 offsets. */
export interface Utf8OffsetMap {
	/** UTF-8 byte length of the mapped text. */
	byteLength: number;
	/**
	 * The 0-based UTF-16 offset a 0-based byte offset falls on. An offset
	 * outside the text clamps to its nearest end, and one inside a multi-byte
	 * character resolves to where that character starts — both keep a slice
	 * taken with the result on a character boundary.
	 */
	toUtf16: (byteOffset: number) => number;
}

/**
 * Index `text` so lute's byte offsets can address it as a JavaScript string.
 *
 * Every position lute reports — a {@link LuauSpan} column, a node offset —
 * counts UTF-8 bytes, Luau's convention across its tooling, while
 * `String.prototype` counts UTF-16 code units. The two agree only while the
 * text stays ASCII: a `∞` is three bytes and one unit, an emoji four bytes and
 * two. Indexing a string with a byte offset therefore lands inside a character
 * as soon as one multi-byte character precedes it.
 *
 * The map is eager — one pass over `text`, one `Int32Array` of its byte length
 * — so each lookup afterwards is a single array read. Callers that convert only
 * part of a file build one map per part rather than one for the whole.
 */
export function createUtf8OffsetMap(text: string): Utf8OffsetMap {
	const byteLength = Buffer.byteLength(text, "utf-8");
	const utf16Offsets = new Int32Array(byteLength + 1);

	let byteOffset = 0;
	let utf16Offset = 0;
	// Iterating a string yields whole code points, so an astral character is
	// one step of four bytes and two UTF-16 units.
	for (const character of text) {
		const codePoint = character.codePointAt(0);
		assert(codePoint !== undefined);
		const width = utf8Width(codePoint);
		// Every byte of the character maps back to where the character starts.
		utf16Offsets.fill(utf16Offset, byteOffset, byteOffset + width);
		byteOffset += width;
		utf16Offset += character.length;
	}

	// One entry past the last byte, so an exclusive end offset converts too.
	utf16Offsets[byteLength] = utf16Offset;

	return {
		byteLength,
		toUtf16: (offset: number): number => {
			const clamped = Math.min(Math.max(offset, 0), byteLength);
			const mapped = utf16Offsets[clamped];
			assert(mapped !== undefined, "Clamped byte offset must be within the map");
			return mapped;
		},
	};
}

/** How many UTF-8 bytes encode `codePoint` (0..0x10FFFF). */
function utf8Width(codePoint: number): number {
	if (codePoint < 0x80) {
		return 1;
	}

	if (codePoint < 0x800) {
		return 2;
	}

	if (codePoint < 0x1_00_00) {
		return 3;
	}

	return 4;
}
