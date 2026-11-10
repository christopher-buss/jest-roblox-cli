import { UNCOMMITTED_REF } from "../related/changed-files.ts";
import { isCountValue, parseVmParallel } from "./option-parsers.ts";
import type { CliOnlyKey, CliOnlyRow, HelpSection, OptionRow } from "./option-row.ts";
import { rowsOf } from "./option-row.ts";
import type { CliOptions } from "./resolved-config.ts";

const TYPE_TESTS: HelpSection = "Type tests";

const CLI_ONLY_OPTIONS: {
	readonly [K in Exclude<CliOnlyKey, "files" | "related">]-?: CliOnlyRow<
		NonNullable<CliOptions[K]>
	>;
} = {
	affectedSince: {
		cli: {
			name: "affected-since",
			help: "Run only packages affected since git ref via turbo/nx",
			section: "Workspace",
			value: "<ref>",
		},
	},
	apiKey: {
		cli: {
			name: "apiKey",
			help: "Roblox Open Cloud API key",
			section: "Open Cloud",
			value: "<key>",
		},
	},
	bail: {
		cli: {
			name: "bail",
			help: "Workspace mode: stop after the first failing package",
			section: "Workspace",
		},
		workspace: "cli",
	},
	changed: {
		cli: {
			name: "changed",
			bare: () => true,
			bareValue: UNCOMMITTED_REF,
			help: "Run tests reaching files changed since a git ref",
			section: "Filtering",
			value: "[since]",
		},
	},
	config: {
		cli: { name: "config", help: "Path to config file", section: "Config", value: "<path>" },
	},
	experimentalVmParallel: {
		cli: {
			name: "experimental-vm-parallel",
			bare: isCountValue,
			help: "Studio-only, experimental: run the configs across n Luau VMs in one Studio session (default: one VM per config; max 4, the hosts the plugin ships). Game output becomes batch-scoped. In workspace mode, splits each package's projects; packages still run in turn",
			parse: parseVmParallel,
			section: "Backend",
			value: "[n]",
		},
		workspace: "cli",
	},
	headed: {
		cli: {
			name: "headed",
			help: "Show the Studio window during the run (studio-cli backend only; default: hidden)",
			section: "Backend",
		},
	},
	help: { cli: { name: "help", help: "Show this help message", section: "General" } },
	packages: {
		cli: {
			name: "packages",
			help: "Comma-separated package names (narrows a workspace run)",
			section: "Workspace",
			value: "<names>",
		},
	},
	project: {
		cli: {
			name: "project",
			help: "Filter which named projects to run",
			multiple: true,
			section: "Filtering",
			value: "<name>",
		},
	},
	typecheck: {
		cli: {
			name: "typecheck",
			help: "Enable type testing (*.spec-d.*, *.test-d.*)",
			section: TYPE_TESTS,
		},
	},
	typecheckOnly: {
		cli: {
			name: "typecheckOnly",
			help: "Run only type tests, skip runtime tests",
			section: TYPE_TESTS,
		},
	},
	typecheckTsconfig: {
		cli: {
			name: "typecheckTsconfig",
			help: "tsconfig for type testing",
			section: TYPE_TESTS,
			value: "<path>",
		},
	},
	version: { cli: { name: "version", help: "Show version number", section: "General" } },
	workspace: {
		cli: {
			name: "workspace",
			help: "Run tests across all workspace packages",
			section: "Workspace",
		},
	},
	workspaceRoot: {
		cli: {
			name: "workspace-root",
			help: "Directory to load the workspace config from (use when running outside any package)",
			section: "Workspace",
			value: "<path>",
		},
	},
};

/** Rows of the options only the command line sets. */
export const CLI_ONLY_ROWS: ReadonlyArray<OptionRow> = rowsOf("cli", CLI_ONLY_OPTIONS);
