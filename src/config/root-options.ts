import { type } from "arktype";

import type { Config } from "./config-types.ts";
import { formatterEntriesSchema } from "./formatter-selection.ts";
import {
	isCountValue,
	parseBackend,
	parseFormatterNames,
	parseParallel,
	parsePositiveInteger,
} from "./option-parsers.ts";
import type { ConfigRow, OptionRow } from "./option-row.ts";
import { rowsOf } from "./option-row.ts";
import { absolutePathSchema, workspaceConfigSchema } from "./option-schemas.ts";
import { BACKENDS } from "./option-values.ts";

type RootKey = Exclude<keyof Config, "test">;

const isBoolean = type("boolean");

const isString = type("string");

const pathOrTrue = type("string").or("true");

const ROOT_OPTIONS: { readonly [K in RootKey]-?: ConfigRow<K, Config[K]> } = {
	backend: {
		cli: {
			name: "backend",
			help: `Backend: ${BACKENDS.join(", ")} (default: auto)`,
			parse: parseBackend,
			section: "Backend",
			value: "<type>",
		},
		schema: type.enumerated(...BACKENDS),
		workspace: "defaulted",
	},
	bootProbeTimeout: { schema: type("number"), workspace: "defaulted" },
	color: {
		cli: {
			name: "color",
			help: "Force colored output",
			negation: { name: "no-color", help: "Disable colored output" },
			section: "Output",
		},
		schema: isBoolean,
		workspace: "defaulted",
	},
	coverageCache: {
		cli: {
			name: "coverage-cache",
			help: "Reuse the incrementally instrumented coverage place",
			negation: {
				name: "no-coverage-cache",
				help: "Force a clean coverage re-instrumentation (skip incremental cache)",
			},
			section: "Coverage",
		},
		schema: isBoolean,
	},
	extends: { schema: type("string").or(type("string[]")) },
	forceRerunTriggers: { schema: type("string[]") },
	formatters: {
		cli: {
			name: "formatters",
			help: "Output formatter: default, agent, json, or github-actions",
			multiple: true,
			parseList: parseFormatterNames,
			section: "Output",
			value: "<name>",
		},
		merger: "array",
		schema: formatterEntriesSchema,
		workspace: "custom",
	},
	gameOutput: {
		cli: {
			name: "gameOutput",
			help: "Write game output (print/warn/error) to file",
			section: "Output",
			value: "<path>",
		},
		schema: pathOrTrue,
		workspace: "optional",
	},
	hiddenDesktop: {
		cli: {
			name: "hiddenDesktop",
			help: "Run the studio-cli Studio hidden (default on Windows and macOS)",
			negation: {
				name: "no-hiddenDesktop",
				help: "Let Studio open on the user's desktop (studio-cli backend)",
			},
			section: "Backend",
		},
		schema: isBoolean,
		workspace: "custom",
	},
	jestPath: { schema: isString },
	luauRoots: { merger: "array", schema: type("string[]") },
	outputFile: {
		cli: {
			name: "outputFile",
			help: "Write results to file",
			section: "Output",
			value: "<path>",
		},
		schema: pathOrTrue,
		workspace: "optional",
	},
	parallel: {
		cli: {
			name: "parallel",
			bare: isCountValue,
			help: 'Open-Cloud-only: number of concurrent sessions, or "auto" = min(jobs, 3) (default: 1 session). Each session costs one task create against Roblox\'s create limit',
			parse: parseParallel,
			section: "Backend",
			value: "[n]",
		},
		schema: type("'auto'").or("number.integer >= 1"),
		workspace: "optional",
	},
	placeFile: { schema: isString },
	placeId: {
		cli: { name: "placeId", help: "Target place ID", section: "Open Cloud", value: "<id>" },
		schema: isString,
		workspace: "optional",
	},
	pluginsDirectory: { schema: absolutePathSchema, workspace: "consensus" },
	port: {
		cli: {
			name: "port",
			help: "WebSocket port for studio backend (default: 3001)",
			parse: parsePositiveInteger("port"),
			section: "Backend",
			value: "<number>",
		},
		schema: type("number"),
		workspace: "defaulted",
	},
	rojoProject: {
		cli: {
			name: "rojoProject",
			help: "Path to rojo project file (auto-detected if not set)",
			section: "Config",
			value: "<path>",
		},
		schema: isString,
	},
	rootDir: { schema: isString },
	showLuau: {
		cli: {
			name: "showLuau",
			help: "Show Luau code in failure output",
			negation: { name: "no-show-luau", help: "Hide Luau code in failure output" },
			section: "Output",
		},
		schema: isBoolean,
		workspace: "defaulted",
	},
	sourceMap: {
		cli: {
			name: "sourceMap",
			help: "Map Luau stack traces to TypeScript source",
			section: "Output",
		},
		schema: isBoolean,
	},
	studioPath: {
		cli: {
			name: "studioPath",
			help: "Roblox Studio executable for the studio-cli backend (auto-detected if not set)",
			section: "Backend",
			value: "<path>",
		},
		schema: isString,
		workspace: "optional",
	},
	timeout: {
		cli: {
			name: "timeout",
			help: "Deadline in ms Roblox is given to run the tests (default: 300000)",
			parse: parsePositiveInteger("timeout"),
			section: "Backend",
			value: "<ms>",
		},
		schema: type("number"),
		workspace: "custom",
	},
	universeId: {
		cli: {
			name: "universeId",
			help: "Target universe ID",
			section: "Open Cloud",
			value: "<id>",
		},
		schema: isString,
		workspace: "optional",
	},
	uploadCache: {
		cli: {
			name: "upload-cache",
			help: "Skip the place upload when its bytes are unchanged",
			negation: {
				name: "no-upload-cache",
				help: "Always upload the place, even when its bytes are unchanged",
			},
			section: "Backend",
		},
		schema: isBoolean,
		workspace: "defaulted",
	},
	workspace: { schema: workspaceConfigSchema, workspace: "custom" },
};

/** Rows of the config root. */
export const ROOT_ROWS: ReadonlyArray<OptionRow> = rowsOf("root", ROOT_OPTIONS);
