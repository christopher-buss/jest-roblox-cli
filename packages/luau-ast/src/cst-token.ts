import type { LuauSpan } from "./ast.ts";

export interface Trivia {
	kind: "blockComment" | "comment" | "whitespace";
	text: string;
}

/** A source token: its text, where it came from, and the trivia around it. */
export interface Token {
	/** Trivia between the previous token's trailing trivia and this token. */
	leading: Array<Trivia>;
	/** Where the token sat: 1-based, exclusive end, UTF-8 byte columns. */
	origin: LuauSpan;
	/** Mutable; the printer emits whatever is here. */
	text: string;
	/** Trivia after the token up to and including the first newline. */
	trailing: Array<Trivia>;
}

/**
 * A token with no trivia yet; materialization attaches it.
 *
 * @param text - The token's text.
 * @param origin - Where the token sat in the source.
 * @returns The token.
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
		"origin" in value &&
		typeof value.origin === "object" &&
		"leading" in value &&
		Array.isArray(value.leading) &&
		"trailing" in value &&
		Array.isArray(value.trailing)
	);
}
