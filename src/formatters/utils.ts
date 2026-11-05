import { type } from "arktype";

import type { FormatterEntry } from "../config/schema.ts";
import type { GitHubActionsFormatterOptions } from "./github-actions.ts";

/**
 * Config accepted after `"agent"` in a formatter entry.
 */
export interface AgentFormatterOptions {
	/**
	 * Most failures to render in full.
	 */
	maxFailures?: number | undefined;
}

type FormatterNameWithOptions = "agent" | "github-actions";

type FormatterOptions = Exclude<FormatterEntry, string>[1];

export const DEFAULT_MAX_FAILURES = 10;

const agentFormatterOptionsSchema = type({
	"+": "reject",
	"maxFailures?": "number",
}).as<AgentFormatterOptions>();

const ghFormatterOptionsSchema = type({
	"+": "reject",
	"displayAnnotations?": "boolean",
	"jobSummary?": {
		"+": "reject",
		"enabled?": "boolean",
		"fileLinks?": {
			"+": "reject",
			"commitHash?": "string",
			"repository?": "string",
			"workspacePath?": "string",
		},
		"outputPath?": "string",
	},
}).as<GitHubActionsFormatterOptions>();

/**
 * Find the options object for a named formatter in a resolved formatter list.
 * Returns `{}` if the formatter is present without options, or `undefined` if
 * absent.
 * @param formatters - Resolved formatter list.
 * @param name - Formatter whose options to find.
 * @returns The validated options, `{}`, or `undefined`.
 * @throws When the options fail the formatter's schema.
 */
export function findFormatterOptions(
	formatters: Array<FormatterEntry> | undefined,
	name: "agent",
): AgentFormatterOptions | undefined;
export function findFormatterOptions(
	formatters: Array<FormatterEntry> | undefined,
	name: "github-actions",
): GitHubActionsFormatterOptions | undefined;
export function findFormatterOptions(
	formatters: Array<FormatterEntry> | undefined,
	name: FormatterNameWithOptions,
): AgentFormatterOptions | GitHubActionsFormatterOptions | undefined {
	if (formatters === undefined) {
		return undefined;
	}

	for (const entry of formatters) {
		if (entry === name) {
			return validateFormatterOptions(name, {});
		}

		if (Array.isArray(entry) && entry[0] === name) {
			return validateFormatterOptions(name, entry[1]);
		}
	}

	return undefined;
}

/**
 * Whether a formatter list names a formatter, with or without options.
 * @param formatters - Resolved formatter list.
 * @param name - Formatter to look for.
 * @returns True when the list names it.
 */
export function hasFormatter(formatters: Array<FormatterEntry> | undefined, name: string): boolean {
	if (formatters === undefined) {
		return false;
	}

	return formatters.some((entry) => (Array.isArray(entry) ? entry[0] === name : entry === name));
}

/**
 * Whether the agent formatter replaces default output; verbose overrides it.
 * @param formatters - Resolved formatter list.
 * @param verbose - Verbose mode, which keeps default output.
 * @returns True when the agent formatter is listed and verbose is off.
 */
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
 * @param options - Formatter list and silent and verbose modes.
 * @returns True when progress output should be written.
 */
export function isDefaultHumanFormatter(options: {
	formatters?: Array<FormatterEntry> | undefined;
	silent?: boolean | undefined;
	verbose?: boolean | undefined;
}): boolean {
	return (
		options.silent !== true &&
		!usesAgentFormatter(options.formatters, options.verbose) &&
		!hasFormatter(options.formatters, "json")
	);
}

function validateFormatterOptions(
	name: FormatterNameWithOptions,
	options: FormatterOptions,
): AgentFormatterOptions | GitHubActionsFormatterOptions {
	if (name === "agent") {
		return agentFormatterOptionsSchema.assert(options);
	}

	return ghFormatterOptionsSchema.assert(options);
}
