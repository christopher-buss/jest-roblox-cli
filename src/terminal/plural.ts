/**
 * The noun form a count takes.
 * @param count - How many there are.
 * @param noun - The singular, or the singular and plural pair for an irregular noun.
 * @returns The singular when `count` is 1, else the plural.
 */
export function plural(count: number, noun: readonly [string, string] | string): string {
	const [singular, pluralForm] = typeof noun === "string" ? [noun, `${noun}s`] : noun;
	return count === 1 ? singular : pluralForm;
}
