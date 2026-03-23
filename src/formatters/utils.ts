import type { FormatterEntry } from "../config/schema.ts";

export interface AgentFormatterOptions {
	maxFailures?: number;
}

export const DEFAULT_MAX_FAILURES = 10;

/**
 * Find the options object for a named formatter in a resolved formatter list.
 * Returns `{}` if the formatter is present without options, or `undefined` if absent.
 */
export function findFormatterOptions(
	formatters: Array<FormatterEntry>,
	name: string,
): Record<string, unknown> | undefined {
	for (const entry of formatters) {
		if (entry === name) {
			return {};
		}

		if (Array.isArray(entry) && entry[0] === name) {
			return entry[1];
		}
	}

	return undefined;
}
