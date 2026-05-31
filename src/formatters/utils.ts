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

export function hasFormatter(formatters: Array<FormatterEntry> | undefined, name: string): boolean {
	if (formatters === undefined) {
		return false;
	}

	return formatters.some((entry) => (Array.isArray(entry) ? entry[0] === name : entry === name));
}

export function usesAgentFormatter(
	formatters: Array<FormatterEntry> | undefined,
	verbose: boolean | undefined = false,
): boolean {
	return hasFormatter(formatters, "agent") && !verbose;
}

/**
 * Whether human-facing progress output (the run header, the "Running X of Y"
 * notice, the workspace streaming lines) should be written: not silent and not
 * a machine-readable formatter (json, or non-verbose agent). The single source
 * of truth so these sinks can't drift apart.
 */
export function isDefaultHumanFormatter(options: {
	formatters?: Array<FormatterEntry>;
	silent?: boolean;
	verbose?: boolean;
}): boolean {
	return (
		options.silent !== true &&
		!usesAgentFormatter(options.formatters, options.verbose) &&
		!hasFormatter(options.formatters, "json")
	);
}
