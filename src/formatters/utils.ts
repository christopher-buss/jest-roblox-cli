import type { FormatterEntry, ResolvedConfig } from "../config/schema.ts";

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

export function hasFormatter(config: ResolvedConfig, name: string): boolean {
	return (
		config.formatters?.some((entry) =>
			Array.isArray(entry) ? entry[0] === name : entry === name,
		) === true
	);
}

export function usesAgentFormatter(config: ResolvedConfig): boolean {
	return hasFormatter(config, "agent") && !config.verbose;
}
