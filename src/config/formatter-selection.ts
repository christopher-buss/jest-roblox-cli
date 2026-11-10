import { type, type Type } from "arktype";

const DEFAULT_MAX_FAILURES = 10;

/** The output formatters a run can name. */
export const FORMATTER_NAMES = ["agent", "default", "github-actions", "json"] as const;

/** An output formatter's name. */
export type FormatterName = (typeof FORMATTER_NAMES)[number];

/**
 * Config accepted after `"agent"` in a formatter entry.
 */
export interface AgentFormatterOptions {
	/**
	 * Most failures to render in full.
	 *
	 * @default 10
	 */
	maxFailures?: number | undefined;
}

/**
 * Options of the `github-actions` formatter.
 */
export interface GitHubActionsFormatterOptions {
	/**
	 * Whether to emit `::error` workflow commands for test failures.
	 *
	 * @default true
	 */
	displayAnnotations?: boolean | undefined;
	/** Configuration for the GitHub Actions Job Summary. */
	jobSummary?: Partial<JobSummaryOptions> | undefined;
}

/** A formatter name, or a `[name, options]` pair. */
export type FormatterEntry =
	| ["agent", AgentFormatterOptions]
	| ["default" | "json", Record<string, never>]
	| ["github-actions", GitHubActionsFormatterOptions]
	| FormatterName;

interface JobSummaryOptions {
	/**
	 * Whether to generate the summary.
	 *
	 * @default true
	 */
	enabled: boolean;
	/** Permalink settings that link test names to source lines. */
	fileLinks: {
		/**
		 * The commit SHA to use in permalink URLs.
		 *
		 * @default process.env.GITHUB_SHA
		 */
		commitHash?: string | undefined;
		/**
		 * The GitHub repository in `owner/repo` format.
		 *
		 * @default process.env.GITHUB_REPOSITORY
		 */
		repository?: string | undefined;
		/**
		 * The absolute path to the root of the repository on disk.
		 *
		 * @default process.env.GITHUB_WORKSPACE
		 */
		workspacePath?: string | undefined;
	};
	/**
	 * File path to write the summary to.
	 *
	 * @default process.env.GITHUB_STEP_SUMMARY
	 */
	outputPath: string | undefined;
}

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

const formatterNameSchema: Type<FormatterName> = type.enumerated(...FORMATTER_NAMES);

export const formatterEntriesSchema: Type<Array<FormatterEntry>> = formatterNameSchema
	.or(type(["'agent'", agentFormatterOptionsSchema]))
	.or(type(["'github-actions'", ghFormatterOptionsSchema]))
	.or(type(["'default' | 'json'", type({ "+": "reject" }).as<Record<string, never>>()]))
	.array();

/** The formatter that renders a run's terminal output. */
export type TerminalFormatter =
	| { maxFailures: number; name: "agent" }
	| { name: "default" }
	| { name: "json" };

/** What decides the terminal formatter. */
export interface FormatterSelectionInput {
	/** Resolved formatter list. */
	formatters?: ReadonlyArray<FormatterEntry> | undefined;
	/** Verbose mode, which keeps default output over the agent formatter. */
	verbose?: boolean | undefined;
}

/**
 * Picks the formatter that renders the terminal output.
 * @param input - Formatter list and verbose mode.
 * @returns The chosen formatter with its options.
 */
export function selectTerminalFormatter({
	formatters = [],
	verbose = false,
}: FormatterSelectionInput): TerminalFormatter {
	const agent = findOptions(formatters, "agent");
	if (agent !== undefined && !verbose) {
		return { name: "agent", maxFailures: agent.maxFailures ?? DEFAULT_MAX_FAILURES };
	}

	if (formatters.some((entry) => entryName(entry) === "json")) {
		return { name: "json" };
	}

	return { name: "default" };
}

/**
 * Whether the agent formatter renders the terminal output.
 * @param input - Formatter list and verbose mode.
 * @returns True when it does.
 */
export function usesAgentFormatter(input: FormatterSelectionInput): boolean {
	return selectTerminalFormatter(input).name === "agent";
}

/**
 * Whether human-facing progress output should be written.
 * @param input - Formatter list and silent and verbose modes.
 * @returns True when progress output should be written.
 */
export function isDefaultHumanFormatter(
	input: FormatterSelectionInput & { silent?: boolean | undefined },
): boolean {
	return input.silent !== true && selectTerminalFormatter(input).name === "default";
}

/**
 * The `github-actions` formatter's options, when the list names it.
 * @param formatters - Resolved formatter list.
 * @returns Its options, `{}` when named bare, or `undefined` when absent.
 */
export function findGitHubActionsOptions(
	formatters: ReadonlyArray<FormatterEntry> | undefined = [],
): GitHubActionsFormatterOptions | undefined {
	return findOptions(formatters, "github-actions");
}

function findOptions(
	formatters: ReadonlyArray<FormatterEntry>,
	name: "agent",
): AgentFormatterOptions | undefined;
function findOptions(
	formatters: ReadonlyArray<FormatterEntry>,
	name: "github-actions",
): GitHubActionsFormatterOptions | undefined;
function findOptions(
	formatters: ReadonlyArray<FormatterEntry>,
	name: "agent" | "github-actions",
): AgentFormatterOptions | GitHubActionsFormatterOptions | undefined {
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

function entryName(entry: FormatterEntry): string {
	return Array.isArray(entry) ? entry[0] : entry;
}
