import type { ReportOptions } from "istanbul-reports";
import type { Except } from "type-fest";

import type { FormatterEntry } from "./formatter-selection.ts";
import type { TypecheckConfig } from "./resolve-typecheck-config.ts";

/** Execution backend that runs the tests. */
export type BackendName = "auto" | "open-cloud" | "studio" | "studio-cli";

/** Name of an Istanbul coverage reporter. */
export type CoverageReporter = keyof ReportOptions;

/**
 * Pretty-format options controlling how snapshots are serialized.
 *
 * @external
 */
export interface SnapshotFormatOptions {
	/** Call a value's `toJSON` method (when present) before serializing it. */
	callToJSON?: boolean;
	/** Escape regex special characters in string snapshots. */
	escapeRegex?: boolean;
	/** Escape backslashes and quotes in string snapshots. */
	escapeString?: boolean;
	/** Number of spaces per indentation level. */
	indent?: number;
	/** Maximum depth of nested objects/arrays to print before collapsing. */
	maxDepth?: number;
	/** Print on a single line with no indentation. */
	min?: boolean;
	/** Print the `Object`/class prototype name for plain objects. */
	printBasicPrototype?: boolean;
	/** Print function names instead of `[Function]`. */
	printFunctionName?: boolean;
}

/** A reporter label with a colour, used to tag a project's output. */
export interface DisplayName {
	/** The label shown in reporter output. */
	name: string;
	/** Colour applied to the label (e.g. `"magenta"`, `"white"`). */
	color: string;
}

/** Jest-passthrough keys valid both at `test:` and per-project. */
export interface SharedTestConfig {
	/** Automatically mock every required module. Default `false`. */
	automock?: boolean;
	/** Clear every mock before each test. Default `false`. */
	clearMocks?: boolean;
	/** Inject Jest's globals into the test environment. Default `true`. */
	injectGlobals?: boolean;
	/** Give each test file a fresh mock DataModel. Default `false`. */
	mockDataModel?: boolean;
	/** Budget in ms for one project's Jest run. Default `60000`; `0` = off. */
	projectTimeout?: number;
	/** Reset every mock before each test. Default `false`. */
	resetMocks?: boolean;
	/** Reset the module registry before each test. Default `false`. */
	resetModules?: boolean;
	/** Restore `spyOn` mocks before each test. Default `false`. */
	restoreMocks?: boolean;
	/** Scripts run before the test framework is installed. */
	setupFiles?: Array<string>;
	/** Scripts run after the framework is installed, before each test file. */
	setupFilesAfterEnv?: Array<string>;
	/** Seconds after which a single test is reported as slow. Default `5`. */
	slowTestThreshold?: number;
	/** Pretty-format options controlling how snapshots are serialized. */
	snapshotFormat?: SnapshotFormatOptions;
	/** DataModel paths to custom snapshot serializer modules. */
	snapshotSerializers?: Array<string>;
	/** Test environment used to run the tests. */
	testEnvironment?: string;
	/** Options forwarded to the test environment. */
	testEnvironmentOptions?: object | string;
	/** Glob patterns Jest uses to detect test files. */
	testMatch?: Array<string>;
	/** Regex patterns of test file paths to skip. */
	testPathIgnorePatterns?: Array<string>;
	/** Regex pattern(s) Jest uses to detect test files. */
	testRegex?: Array<string> | string;
	/** Default per-test timeout in milliseconds. Default `5000`. */
	testTimeout?: number;
	/** Host-only Type Test config. */
	typecheck?: TypecheckConfig;
}

/** Jest-passthrough keys valid only per-project (under `projects[N].test`). */
export interface ProjectTestConfig extends SharedTestConfig {
	/** Reporter label for this project. Must be unique across projects. */
	displayName: DisplayName | string;
	/** Globs subtracted from this project's Runtime Test discovery. */
	exclude?: Array<string>;
	/** Globs selecting this project's test files, relative to `root`. */
	include: Array<string>;
	/** Compiled-output directory of the project's `.luau`. */
	outDir?: string;
	/** Base path for this project's `include`, `exclude`, and `outDir`. */
	root?: string;
}

/** An inline project entry in `projects`. */
export interface InlineProjectConfig {
	/** The project's Jest options. */
	test: ProjectTestConfig;
}

/** A project config file as authored. */
export interface ProjectConfigFile extends Except<ProjectTestConfig, "include"> {
	/** See {@link ProjectTestConfig.include}. */
	include?: Array<string>;
}

/** Workspace-only knobs. Ignored outside `--workspace` mode. */
export interface WorkspaceConfig {
	/** Package directory globs a run skips unless `--packages` names them. */
	exclude?: Array<string>;
	/** Emit one Per-package Game Output file per package and project. */
	gameOutput?: true;
	/** Emit one per-package result file per package and project. */
	outputFile?: true;
	/** Globs selecting package directories. Requires `root`. */
	packages?: Array<string>;
	/** Workspace root, relative to the declaring file. Requires `packages`. */
	root?: string;
}

/** A `projects` entry: a DataModel path string or an inline project. */
export type ProjectEntry = InlineProjectConfig | string;

/** Jest-passthrough keys valid only at root `test:` (not per-project). */
export interface GlobalTestConfig extends SharedTestConfig {
	/** Report coverage for untested files too. Default `false`. */
	all?: boolean;
	/** Stop the run after `n` failing test suites. Default `0`. */
	bail?: boolean | number;
	/** Run only tests affected by files changed since the given git ref. */
	changedSince?: string;
	/** Assume a CI environment, which disables writing new snapshots. */
	ci?: boolean;
	/** Clear Jest's transform cache before running, then exit. */
	clearCache?: boolean;
	/** Collect code coverage during the run. Default `false`. */
	collectCoverage?: boolean;
	/** Globs selecting which source files coverage is collected from. */
	collectCoverageFrom?: Array<string>;
	/** Alias for `collectCoverage`. */
	coverage?: boolean;
	/** Globs for files a coverage run does not copy into the place. */
	coverageCopyIgnorePatterns?: Array<string>;
	/** Directory coverage reports are written to. Default `"coverage"`. */
	coverageDirectory?: string;
	/** Globs excluded from coverage collection. */
	coveragePathIgnorePatterns?: Array<string>;
	/** Istanbul reporters to emit. Default `["text", "lcov"]`. */
	coverageReporters?: Array<CoverageReporter>;
	/** Minimum coverage percentages; the run fails below any. */
	coverageThreshold?: {
		/** Minimum branch coverage percentage. */
		branches?: number;
		/** Minimum function coverage percentage. */
		functions?: number;
		/** Minimum line coverage percentage. */
		lines?: number;
		/** Minimum statement coverage percentage. */
		statements?: number;
	};
	/** Print Jest's resolved config and debugging info. */
	debug?: boolean;
	/** Reporter label for the whole run — a string, or `{ name, color }`. */
	displayName?: DisplayName | string;
	/** Test environment to use, forwarded to the Jest runtime. */
	env?: string;
	/** Globs subtracted from Runtime Test discovery. */
	exclude?: Array<string>;
	/** Show full diffs and error output instead of truncating. */
	expand?: boolean;
	/** A JSON string of globals to expose in every test environment. */
	globals?: string;
	/** Per-project globs selecting Runtime Test files. */
	include?: Array<string>;
	/** Maximum worker count, or a percentage string like `"50%"`. */
	maxWorkers?: number | string;
	/** Omit stack traces from failure output. */
	noStackTrace?: boolean;
	/** Default compiled-output directory for test discovery. */
	outDir?: string;
	/** Exit `0` even when no tests are found. Default `false`. */
	passWithNoTests?: boolean;
	/** Name of a preset that supplies base Jest config. */
	preset?: string;
	/** Per-project configs for a multi-project run. */
	projects?: Array<ProjectEntry>;
	/** Reporter modules (DataModel paths) used to format results. */
	reporters?: Array<string>;
	/** Root directories Jest scans for tests and modules. */
	roots?: Array<string>;
	/** Run all tests serially in the current process instead of in workers. */
	runInBand?: boolean;
	/** Run only the projects whose `displayName` is listed. */
	selectProjects?: Array<string>;
	/** Print the resolved config and exit without running tests. */
	showConfig?: boolean;
	/** Suppress test `print`/console output. Default `false`. */
	silent?: boolean;
	/** Process exit code used when tests fail. */
	testFailureExitCode?: string;
	/** Run only tests whose full name matches this regex. */
	testNamePattern?: string;
	/** Run only test files whose path matches this regex. */
	testPathPattern?: string;
	/** Fake-timers mode (e.g. `"real"`, `"fake"`). */
	timers?: string;
	/** Update stored snapshots to match current output. */
	updateSnapshot?: boolean;
	/** Report each individual test result. Default `false`. */
	verbose?: boolean;
}

/** Root-level config: runner keys plus the `test:` block. */
export interface Config {
	/** Execution backend. Default `"auto"`. */
	backend?: BackendName;
	/** Boot probe budget in ms. Default `90000`; `0` skips the probe. */
	bootProbeTimeout?: number;
	/** Force ANSI colour in output. Default `true`. */
	color?: boolean;
	/** Reuse the instrumented coverage place between runs. Default `true`. */
	coverageCache?: boolean;
	/** Config files to inherit from, relative to this file. */
	extends?: Array<string> | string;
	/** Output formatters. Default `["default"]`. */
	formatters?: Array<FormatterEntry>;
	/** Where to write Game Output; `true` = `game-output.log`. */
	gameOutput?: string | true;
	/**
	 * Run the `"studio-cli"` Studio hidden. Default `true` on Windows/macOS.
	 */
	hiddenDesktop?: boolean;
	/** DataModel path to the Jest module. Auto-detected by default. */
	jestPath?: string;
	/** Compiled-Luau directories to instrument for coverage. */
	luauRoots?: Array<string>;
	/** Where to write the Jest result JSON; `true` = `jest-output.log`. */
	outputFile?: string | true;
	/** Number of places to shard the run across, or `"auto"`. */
	parallel?: "auto" | number;
	/** Path to the `.rbxl` place uploaded and run. Default `"./game.rbxl"`. */
	placeFile?: string;
	/** Open Cloud place id to publish/run against. */
	placeId?: string;
	/** Absolute Studio plugins folder path; also `JEST_ROBLOX_PLUGINS_DIR`. */
	pluginsDirectory?: string;
	/** WebSocket port for the Studio backend. Default `3001`. */
	port?: number;
	/** Path to the Rojo project file. Auto-detected when unset. */
	rojoProject?: string;
	/** Base directory for relative paths, relative to the config file. */
	rootDir?: string;
	/** Include the translated Luau line in error output. Default `true`. */
	showLuau?: boolean;
	/** Map Luau stack traces back to TypeScript source. Default `true`. */
	sourceMap?: boolean;
	/** Roblox Studio executable for the `"studio-cli"` backend. */
	studioPath?: string;
	/** The Jest options block. */
	test?: GlobalTestConfig;
	/** Deadline in ms Roblox is given to run the script. Default `300000`. */
	timeout?: number;
	/** Open Cloud universe id that owns the place. */
	universeId?: string;
	/** Skip the upload when the place is already uploaded. Default `true`. */
	uploadCache?: boolean;
	/** Workspace-mode knobs. Ignored outside `--workspace`. */
	workspace?: WorkspaceConfig;
}
