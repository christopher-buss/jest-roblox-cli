const CONFIG_PLACEHOLDER = /\[(=*)\[__CONFIG_JSON__\]\1\]/;

/**
 * Wrap `content` in a Luau long string whose level is one above the highest
 * `]=*]` terminator it contains, so no content closes the string early.
 *
 * @param content - Text to wrap.
 * @returns A Luau long string literal.
 */
export function luauLongString(content: string): string {
	let level = 1;
	while (content.includes(`]${"=".repeat(level)}]`)) {
		level += 1;
	}

	const equals = "=".repeat(level);
	return `[${equals}[${content}]${equals}]`;
}

/**
 * Replace a template's `[=[__CONFIG_JSON__]=]` long string, at any level,
 * with `json` in a long string that `json` cannot close.
 *
 * @param template - Luau source holding the placeholder.
 * @param json - Serialized payload to embed.
 * @returns The template with the payload embedded.
 */
export function embedConfigJson(template: string, json: string): string {
	return template.replace(CONFIG_PLACEHOLDER, () => luauLongString(json));
}
