import { type, type Type } from "arktype";

import type { GlobalTestConfig, ProjectTestConfig } from "./config-types.ts";
import { parseCoverageReporters } from "./option-parsers.ts";
import type { ConfigRow, OptionRow } from "./option-row.ts";
import { objectDefinition, rowsOf } from "./option-row.ts";
import {
	coverageThresholdSchema,
	displayNameSchema,
	snapshotFormatSchema,
	typecheckConfigSchema,
} from "./option-schemas.ts";
import { COVERAGE_REPORTERS } from "./option-values.ts";

type SharedTestKey = Extract<keyof GlobalTestConfig, keyof ProjectTestConfig>;

type GlobalOnlyKey = Exclude<keyof GlobalTestConfig, keyof ProjectTestConfig>;

type ProjectOnlyKey = Exclude<keyof ProjectTestConfig, keyof GlobalTestConfig>;

/**
 * A key a project's `test` block requires must say so.
 *
 * @template K - The key.
 */
type ProjectRequirement<K extends keyof ProjectTestConfig> =
	object extends Pick<ProjectTestConfig, K>
		? { readonly projectRequired?: never }
		: { readonly projectRequired: true };

const isBoolean = type("boolean");

const isString = type("string");

const stringList = type("string[]");

const SHARED_TEST_OPTIONS: {
	readonly [K in SharedTestKey]-?: ConfigRow<K, GlobalTestConfig[K]> & ProjectRequirement<K>;
} = {
	automock: { jest: true, schema: isBoolean },
	clearMocks: { jest: true, schema: isBoolean },
	displayName: { jest: true, projectRequired: true, schema: displayNameSchema },
	exclude: { jest: true, schema: stringList },
	include: { jest: true, projectRequired: true, schema: stringList },
	injectGlobals: { jest: true, schema: isBoolean },
	mockDataModel: { jest: true, schema: isBoolean },
	outDir: { jest: true, schema: isString },
	projectTimeout: { schema: type("number >= 0") },
	resetMocks: { jest: true, schema: isBoolean },
	resetModules: { jest: true, schema: isBoolean },
	restoreMocks: { jest: true, schema: isBoolean },
	setupFiles: {
		cli: {
			name: "setupFiles",
			help: "Setup script, a package specifier or relative path",
			multiple: true,
			section: "Config",
			value: "<path>",
		},
		jest: true,
		merger: "array",
		schema: stringList,
	},
	setupFilesAfterEnv: {
		cli: {
			name: "setupFilesAfterEnv",
			help: "Post-env setup script, a package specifier or relative path",
			multiple: true,
			section: "Config",
			value: "<path>",
		},
		jest: true,
		merger: "array",
		schema: stringList,
	},
	slowTestThreshold: { jest: true, schema: type("number > 0"), workspace: "optional" },
	snapshotFormat: { jest: true, merger: "object", schema: snapshotFormatSchema },
	snapshotSerializers: { jest: true, merger: "array", schema: stringList },
	testEnvironment: { jest: true, schema: isString },
	testEnvironmentOptions: { jest: true, schema: type("string").or(type("object")) },
	testMatch: { jest: true, merger: "array", schema: stringList },
	testPathIgnorePatterns: { jest: true, merger: "array", schema: stringList },
	testRegex: { jest: true, schema: type("string").or(stringList) },
	testTimeout: { jest: true, schema: type("number") },
	typecheck: { schema: typecheckConfigSchema },
};

const PROJECT_ONLY_OPTIONS: {
	readonly [K in ProjectOnlyKey]-?: ConfigRow<K, ProjectTestConfig[K]>;
} = {
	root: { schema: isString },
};

/** Rows of a project's `test` block. */
export const PROJECT_TEST_ROWS: ReadonlyArray<OptionRow> = [
	...rowsOf("test-shared", SHARED_TEST_OPTIONS),
	...rowsOf("project", PROJECT_ONLY_OPTIONS),
];

const projectTestConfigSchema: Type<ProjectTestConfig> = type(
	objectDefinition(PROJECT_TEST_ROWS, (row) => row.projectRequired === true),
).as<ProjectTestConfig>();

const GLOBAL_ONLY_OPTIONS: {
	readonly [K in GlobalOnlyKey]-?: ConfigRow<K, GlobalTestConfig[K]>;
} = {
	all: { jest: true, schema: isBoolean },
	bail: { jest: true, schema: type("boolean").or(type("number")) },
	changedSince: { jest: true, schema: isString },
	ci: { jest: true, schema: isBoolean },
	clearCache: { jest: true, schema: isBoolean },
	collectCoverage: {
		cli: {
			name: "coverage",
			help: "Enable coverage collection",
			negation: {
				name: "no-coverage",
				help: "Disable coverage for this run (overrides config)",
			},
			section: "Coverage",
		},
		schema: isBoolean,
	},
	collectCoverageFrom: {
		cli: {
			name: "collectCoverageFrom",
			help: "Globs for files to include in coverage",
			multiple: true,
			section: "Coverage",
			value: "<glob>",
		},
		merger: "array",
		schema: stringList,
	},
	coverage: { schema: isBoolean },
	coverageCopyIgnorePatterns: { merger: "array", schema: stringList },
	coverageDirectory: {
		cli: {
			name: "coverageDirectory",
			help: "Directory for coverage output (default: coverage)",
			section: "Coverage",
			value: "<path>",
		},
		schema: isString,
	},
	coveragePathIgnorePatterns: { merger: "array", schema: stringList },
	coverageReporters: {
		cli: {
			name: "coverageReporters",
			help: "Coverage reporter; text and lcov by default",
			multiple: true,
			parseList: parseCoverageReporters,
			section: "Coverage",
			value: "<name>",
		},
		merger: "array",
		schema: type.enumerated(...COVERAGE_REPORTERS).array(),
	},
	coverageThreshold: { merger: "object", schema: coverageThresholdSchema },
	debug: { jest: true, schema: isBoolean },
	env: { jest: true, schema: isString },
	expand: { jest: true, schema: isBoolean },
	globals: { jest: true, schema: isString },
	maxWorkers: { jest: true, schema: type("number").or(type("string")) },
	noStackTrace: { jest: true, schema: isBoolean },
	passWithNoTests: {
		cli: {
			name: "passWithNoTests",
			help: "Exit with 0 when no test files are found",
			section: "Filtering",
		},
		jest: true,
		schema: isBoolean,
	},
	preset: { jest: true, schema: isString },
	projects: {
		jest: true,
		schema: type("string")
			.or(type({ "+": "reject", "test": projectTestConfigSchema }))
			.array(),
	},
	reporters: { jest: true, merger: "array", schema: stringList },
	roots: { jest: true, merger: "array", schema: stringList },
	runInBand: { jest: true, schema: isBoolean },
	selectProjects: { jest: true, merger: "array", schema: stringList },
	showConfig: { jest: true, schema: isBoolean },
	silent: {
		cli: { name: "silent", help: "Suppress output", section: "Output" },
		jest: true,
		schema: isBoolean,
		workspace: "defaulted",
	},
	testFailureExitCode: { jest: true, schema: isString },
	testNamePattern: {
		cli: {
			name: "testNamePattern",
			help: "Filter tests by name pattern",
			section: "Filtering",
			short: "t",
			value: "<regex>",
		},
		jest: true,
		schema: isString,
	},
	testPathPattern: {
		cli: {
			name: "testPathPattern",
			help: "Filter test files by path pattern",
			section: "Filtering",
			value: "<regex>",
		},
		jest: true,
		schema: isString,
	},
	timers: { jest: true, schema: isString },
	updateSnapshot: {
		cli: {
			name: "updateSnapshot",
			help: "Update snapshot files",
			section: "Filtering",
			short: "u",
		},
		jest: true,
		schema: isBoolean,
	},
	verbose: {
		cli: { name: "verbose", help: "Show individual test results", section: "Output" },
		jest: true,
		schema: isBoolean,
		workspace: "defaulted",
	},
};

/** Rows of the root `test:` block. */
export const GLOBAL_TEST_ROWS: ReadonlyArray<OptionRow> = [
	...rowsOf("test-shared", SHARED_TEST_OPTIONS),
	...rowsOf("test-global", GLOBAL_ONLY_OPTIONS),
];
