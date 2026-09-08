/**
 * The value a Luau string literal denotes, decoded the way the lexer reads
 * it: a quoted literal's escapes are resolved, and a long bracket's first
 * newline is dropped. The token text is the literal as written, delimiters
 * included.
 *
 * @param text - The literal's token text.
 * @returns The string value.
 */
export function decodeLuauString(text: string): string {
	const longBracket = LONG_BRACKET_OPEN.exec(text);
	if (longBracket) {
		const opener = longBracket[0];
		const body = text.slice(opener.length, text.length - opener.length);
		return body.replace(LEADING_NEWLINE, "");
	}

	const body = text.slice(1, -1);
	return body.includes("\\") ? decodeEscapes(body) : body;
}

const LONG_BRACKET_OPEN = /^\[=*\[/;
const LEADING_NEWLINE = /^(?:\r\n|\n\r|\r|\n)/;
const ESCAPE = /\\(?:z\s*|(\r\n|\n\r|\r|\n)|x([0-9A-Fa-f]{2})|u\{([0-9A-Fa-f]+)\}|(\d{1,3})|(.))/gu;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SIMPLE_ESCAPES: ReadonlyMap<string, number> = new Map([
	["a", 0x07],
	["b", 0x08],
	["f", 0x0c],
	["n", 0x0a],
	["r", 0x0d],
	["t", 0x09],
	["v", 0x0b],
]);

function appendText(bytes: Array<number>, text: string): void {
	for (const byte of encoder.encode(text)) {
		bytes.push(byte);
	}
}

/**
 * Resolve the escapes of a quoted literal's body. Byte escapes (`\xHH`,
 * `\ddd`) can spell any byte, so the body is assembled as bytes and decoded
 * once at the end, matching how the parser's UTF-8 output reaches JSON.
 *
 * @param body - The literal's text between its quotes.
 * @returns The decoded value.
 */
function decodeEscapes(body: string): string {
	const bytes: Array<number> = [];
	let cursor = 0;
	for (const match of body.matchAll(ESCAPE)) {
		appendText(bytes, body.slice(cursor, match.index));
		cursor = match.index + match[0].length;

		const [, newline, hex, codepoint, decimal, simple] = match;
		if (newline !== undefined) {
			bytes.push(0x0a);
		} else if (hex !== undefined) {
			bytes.push(Number.parseInt(hex, 16));
		} else if (codepoint !== undefined) {
			appendText(bytes, String.fromCodePoint(Number.parseInt(codepoint, 16)));
		} else if (decimal !== undefined) {
			bytes.push(Number(decimal));
		} else if (simple !== undefined) {
			const byte = SIMPLE_ESCAPES.get(simple);
			if (byte === undefined) {
				appendText(bytes, simple);
			} else {
				bytes.push(byte);
			}
		}
	}

	appendText(bytes, body.slice(cursor));
	return decoder.decode(Uint8Array.from(bytes));
}
