import type { LuauSpan } from "./ast-types.ts";

/** Whitespace or a comment between source tokens. */
export interface Trivia {
	/** Whether the trivia is whitespace, a line comment, or a block comment. */
	kind: "blockComment" | "comment" | "whitespace";
	/** Source spelling of this trivia segment. */
	text: string;
}

/** A source token: its text, where it came from, and the trivia around it. */
export interface Token {
	/**
	 * Rule that constructed this token, retained across the checkpoint parse.
	 */
	generatedBy?: string;
	/** Trivia between the previous token's trailing trivia and this token. */
	leading: Array<Trivia>;
	/**
	 * Where the token sat: 1-based, exclusive end, UTF-8 byte columns. Absent
	 * on a token that came from node construction rather than the source.
	 */
	origin?: LuauSpan;
	/** Mutable; the printer emits whatever is here. */
	text: string;
	/** Trivia after the token up to and including the first newline. */
	trailing: Array<Trivia>;
}

/**
 * A token with no trivia yet; materialization attaches it.
 *
 * @param text - Source spelling emitted by the printer.
 * @param origin - Where the token sat in the source.
 * @returns A printable source element with empty trivia lists.
 */
export function createToken(text: string, origin: LuauSpan): Token {
	return { leading: [], origin, text, trailing: [] };
}

/**
 * Whether a value in the tree is a token rather than a node, a list, or a
 * punctuated entry.
 *
 * @param value - Any value reached by walking the tree.
 * @returns Whether it is a token.
 */
export function isToken(value: unknown): value is Token {
	return (
		typeof value === "object" &&
		value !== null &&
		"text" in value &&
		typeof value.text === "string" &&
		"leading" in value &&
		Array.isArray(value.leading) &&
		"trailing" in value &&
		Array.isArray(value.trailing)
	);
}
