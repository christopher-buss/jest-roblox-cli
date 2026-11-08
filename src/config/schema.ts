import type { ReportOptions } from "istanbul-reports";
import * as path from "node:path";
import process from "node:process";
import type { Except } from "type-fest";

import type { TypecheckConfig } from "./resolve-typecheck-config.ts";

/** Execution backend that runs the tests. */
export type Backend = "auto" | "open-cloud" | "studio" | "studio-cli";

/** Name of an Istanbul coverage reporter. */
export type CoverageReporter = keyof ReportOptions;

/** A formatter name, or a `[name, options]` pair. */
export type FormatterEntry = [string, object] | string;

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
	/**
	 * Clear `mock.calls`/`instances`/`results` on every mock before each test
	 * (like `jest.clearAllMocks()`). Default `false`.
	 */
	clearMocks?: boolean;
	/**
	 * Inject Jest's globals (`describe`, `it`, `expect`, …) into the test
	 * environment instead of requiring them explicitly. Default `true`.
	 */
	injectGlobals?: boolean;
	/**
	 * Swap the live Roblox DataModel for a fresh mock instance per test file
	 * so tests can mutate the tree in isolation. Default `false`.
	 */
	mockDataModel?: boolean;
	/**
	 * Wall-clock budget in milliseconds for one project's whole Jest run,
	 * enforced inside the Roblox runtime. Default `60000`; `0` turns it off.
	 *
	 * The middle rung of three: `test.testTimeout` bounds a single test, this
	 * bounds every test one project runs, and the root `timeout` bounds the
	 * whole Open Cloud task. A project that outlives its budget is abandoned
	 * and reported as timed out, and the run moves on to the next one.
	 */
	projectTimeout?: number;
	/**
	 * Reset mock state and remove any mocked implementation before each test
	 * (like `jest.resetAllMocks()`). Default `false`.
	 */
	resetMocks?: boolean;
	/**
	 * Reset the module registry before each test so every test re-requires a
	 * fresh module graph. Default `false`.
	 */
	resetModules?: boolean;
	/**
	 * Restore `spyOn` mocks to their original implementations before each test
	 * (like `jest.restoreAllMocks()`). Default `false`.
	 */
	restoreMocks?: boolean;
	/**
	 * DataModel paths to scripts run once before the test framework is
	 * installed.
	 */
	setupFiles?: Array<string>;
	/**
	 * DataModel paths to scripts run after the framework is installed, before
	 * each test file — the place for global hooks and custom matchers.
	 */
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
	/**
	 * Regex patterns; a test file is skipped when its path matches any of
	 * them.
	 */
	testPathIgnorePatterns?: Array<string>;
	/**
	 * Regex pattern(s) Jest uses to detect test files (alternative to
	 * `testMatch`).
	 */
	testRegex?: Array<string> | string;
	/** Default per-test timeout in milliseconds. Default `5000`. */
	testTimeout?: number;
	/**
	 * Host-only Type Test config. Never forwarded to the Roblox runtime.
	 * Resolved per-project via `resolveTypecheckConfig`.
	 */
	typecheck?: TypecheckConfig;
}

/** Jest-passthrough keys valid only per-project (under `projects[N].test`). */
export interface ProjectTestConfig extends SharedTestConfig {
	/**
	 * Reporter label identifying this project's tests — a string, or
	 * `{ name, color }` to tint it. Must be unique across projects.
	 */
	displayName: DisplayName | string;
	/** Globs subtracted from this project's Runtime Test discovery. */
	exclude?: Array<string>;
	/**
	 * Globs (with TS extensions) selecting this project's test files, relative
	 * to `root`. The static directory prefix of each glob maps to a Rojo
	 * `$path`/DataModel mount.
	 */
	include: Array<string>;
	/**
	 * Compiled-output directory the project's `.luau` lives in. Setting it
	 * pins the project to a single DataModel mount (exact Rojo lookup, no
	 * auto-expand). Point it at the roblox-ts compiled output (e.g.
	 * `"out/client"`), not `"src/…"`.
	 */
	outDir?: string;
	/**
	 * Base path prepended to this project's `include`, `exclude`, and
	 * `outDir`.
	 */
	root?: string;
}

/** An inline project entry in `projects`. */
export interface InlineProjectConfig {
	/** The project's Jest options. */
	test: ProjectTestConfig;
}

/**
 * A project config file as authored. `include` is optional here because
 * `deriveIncludeFromTestMatch` fills it in from `testMatch` after the file is
 * read; {@link ProjectTestConfig} is the shape the rest of the CLI consumes.
 */
export interface ProjectConfigFile extends Except<ProjectTestConfig, "include"> {
	/** See {@link ProjectTestConfig.include}. */
	include?: Array<string>;
}

/** Workspace-only knobs. Ignored outside `--workspace` mode. */
export interface WorkspaceConfig {
	/**
	 * Globs, relative to the workspace root, naming package directories a
	 * workspace run must never select on its own — test fixtures the package
	 * manager installs as real members, most often. `--packages` overrides
	 * this: naming a package is asking for it.
	 *
	 * Independent of `packages`/`root`, so it narrows the `pnpm-workspace.yaml`
	 * source too.
	 */
	exclude?: Array<string>;
	/**
	 * When `true`, emit one Per-package Game Output file per selected
	 * (package, project) under `<workspaceRoot>/.jest-roblox/output/`.
	 * Consensus-resolved across packages; only `true` is accepted.
	 */
	gameOutput?: true;
	/**
	 * When `true`, emit one per-package result file (the Jest result JSON)
	 * per selected (package, project) under
	 * `<workspaceRoot>/.jest-roblox/output/`. Consensus-resolved across
	 * packages; only `true` is accepted.
	 */
	outputFile?: true;
	/**
	 * Globs (relative to `root`) selecting package directories — each must
	 * contain a `jest.config.*`. Lets workspace mode enumerate packages in
	 * Luau-only / npm / yarn repos that have no `pnpm-workspace.yaml`.
	 * Required together with `root`; independent of `gameOutput`/`outputFile`.
	 */
	packages?: Array<string>;
	/**
	 * The workspace root. Relative in source; resolved to an absolute path at
	 * load, anchored to the file that declares it (typically a shared config
	 * reached via `extends:`). Required together with `packages`.
	 */
	root?: string;
}

/** A `projects` entry: a DataModel path string or an inline project. */
export type ProjectEntry = InlineProjectConfig | string;

/** Jest-passthrough keys valid only at root `test:` (not per-project). */
export interface GlobalTestConfig extends SharedTestConfig {
	/**
	 * Report coverage for every file matched by the coverage globs, even those
	 * no test exercised (untested files count as 0%). Default `false`.
	 */
	all?: boolean;
	/**
	 * Stop the run after `n` failing test suites (`true` ⇒ after the first).
	 * Default `0` (never bail).
	 */
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
	/**
	 * Globs for files a coverage run never copies into the instrumented place
	 * it builds. Matched against each file's path relative to its compiled
	 * root, so `**\/*.d.ts` and `foo/bar.json` both work.
	 *
	 * Distinct from `coveragePathIgnorePatterns`, which decides what the
	 * report covers: this one decides what reaches the place at all, and a
	 * pattern that matches a `.luau` removes that module from the build.
	 *
	 * Defaults to the three sidecars roblox-ts emits beside every module: rojo
	 * mounts none of those extensions, and every reader of a source map opens
	 * the one in `outDir`. Declare a function to keep them and add your own.
	 *
	 * ```ts
	 * coverageCopyIgnorePatterns: (defaults) => [...defaults, "**\/*.tsbuildinfo"],
	 * ```
	 */
	coverageCopyIgnorePatterns?: Array<string>;
	/** Directory coverage reports are written to. Default `"coverage"`. */
	coverageDirectory?: string;
	/** Globs excluded from coverage collection. */
	coveragePathIgnorePatterns?: Array<string>;
	/**
	 * Istanbul reporters to emit (e.g. `"text"`, `"lcov"`, `"html"`). Default
	 * `["text", "lcov"]`.
	 */
	coverageReporters?: Array<CoverageReporter>;
	/**
	 * Minimum coverage percentages (0–100); the run fails when any is not met.
	 */
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
	/**
	 * Globs subtracted from Runtime Test discovery. Applies to single-,
	 * multi-project, and `--workspace` runs (skipped for explicit file args).
	 */
	exclude?: Array<string>;
	/** Show full diffs and error output instead of truncating. */
	expand?: boolean;
	/** A JSON string of globals to expose in every test environment. */
	globals?: string;
	/**
	 * Per-project globs selecting Runtime Test files. With no `projects`
	 * configured, the run derives one project per `luauRoots` mount and runtime
	 * discovery uses `testMatch` — this root-level `include` is not consumed
	 * there.
	 */
	include?: Array<string>;
	/**
	 * Maximum worker count, or a percentage string like `"50%"`, for parallel
	 * test execution.
	 */
	maxWorkers?: number | string;
	/** Omit stack traces from failure output. */
	noStackTrace?: boolean;
	/**
	 * Default compiled-output directory for test discovery when not set
	 * per-project.
	 */
	outDir?: string;
	/** Exit `0` even when no tests are found. Default `false`. */
	passWithNoTests?: boolean;
	/** Name of a preset that supplies base Jest config. */
	preset?: string;
	/**
	 * Per-project configs for a multi-project run. Each entry is a DataModel
	 * path string, or an inline `defineProject` object.
	 */
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
	/**
	 * Report each individual test result, not just suite summaries. Default
	 * `false`.
	 */
	verbose?: boolean;
}

/**
 * Root-level config: CLI/runner keys plus the `test:` block where all
 * jest-passthrough options live.
 */
export interface Config {
	/**
	 * Execution backend. `"auto"` selects `"studio-cli"` when Roblox Studio is
	 * installed, otherwise `"open-cloud"`; `"open-cloud"` uploads and runs via
	 * Roblox Open Cloud; `"studio"` drives a locally running Studio;
	 * `"studio-cli"` launches its own headless Studio via `--task RunScript`
	 * and quits it (pass `--headed` to show the Studio window during the run).
	 * Default `"auto"`. `"studio"` is never selected by `"auto"` — request it
	 * explicitly.
	 */
	backend?: Backend;
	/**
	 * Budget in milliseconds for the boot probe after uploading, run against
	 * the uploaded version. Default `90000`. Only a completed probe earns an
	 * upload-cache entry. A lost probe gets one more; a second loss stops the
	 * run before any test task. Zero skips the probe and prevents new cache
	 * entries.
	 */
	bootProbeTimeout?: number;
	/** Force ANSI colour in output. Default `true`. */
	color?: boolean;
	/**
	 * Reuse the incrementally-instrumented coverage place between runs when
	 * nothing changed. Default `true`.
	 */
	coverageCache?: boolean;
	/**
	 * One or more config files to inherit from (c12 layering), relative to
	 * this file. Local keys win over extended ones.
	 */
	extends?: Array<string> | string;
	/**
	 * Output formatters — `"default"`, `"agent"`, `"json"`,
	 * `"github-actions"` — each a name or a `[name, options]` pair. Default
	 * `["default"]`.
	 */
	formatters?: Array<FormatterEntry>;
	/**
	 * Where to write Game Output. A path, or `true` to default to
	 * `game-output.log` under the root. In workspace mode this becomes the
	 * single Aggregated Game Output file (consensus-resolved).
	 */
	gameOutput?: string | true;
	/**
	 * Run the `"studio-cli"` Studio hidden: on a hidden desktop on Windows,
	 * launched without focus and kept hidden on macOS. Defaults to `true` on
	 * Windows and macOS; `false` opts out. Elsewhere the default does nothing
	 * and `true` is ignored with a warning. `--headed` overrides it. Also
	 * settable via `--hiddenDesktop` / `--no-hiddenDesktop`.
	 */
	hiddenDesktop?: boolean;
	/**
	 * DataModel path to the Jest module the runner requires (e.g.
	 * `"ReplicatedStorage/Packages/Jest"`). Defaults to auto-detection in
	 * ReplicatedStorage.
	 */
	jestPath?: string;
	/**
	 * Compiled-Luau directories to instrument for coverage. Defaults to the
	 * tsconfig `outDir`.
	 */
	luauRoots?: Array<string>;
	/**
	 * Where to write the Jest result JSON. A path, or `true` to default to
	 * `jest-output.log` under the root. In workspace mode this becomes the
	 * single aggregated result file (consensus-resolved).
	 */
	outputFile?: string | true;
	/**
	 * Number of places to shard the run across, or `"auto"` to pick
	 * automatically.
	 */
	parallel?: "auto" | number;
	/** Path to the `.rbxl` place uploaded and run. Default `"./game.rbxl"`. */
	placeFile?: string;
	/** Open Cloud place id to publish/run against. */
	placeId?: string;
	/** Absolute Studio plugins folder path; also `JEST_ROBLOX_PLUGINS_DIR`. */
	pluginsDirectory?: string;
	/** WebSocket port for the Studio backend. Default `3001`. */
	port?: number;
	/**
	 * Path to the Rojo project file used to map DataModel paths to source.
	 * Auto-detected when unset.
	 */
	rojoProject?: string;
	/**
	 * Base directory for resolving relative paths. Defaults to the current
	 * working directory. A relative value resolves against the directory the
	 * config was loaded from, which in workspace mode is the package
	 * directory — so `rootDir: "."` names the package, not the workspace root.
	 */
	rootDir?: string;
	/**
	 * Include the translated Luau line in error/stack output. Default `true`.
	 */
	showLuau?: boolean;
	/** Map Luau stack traces back to TypeScript source. Default `true`. */
	sourceMap?: boolean;
	/**
	 * Path to the Roblox Studio executable the `"studio-cli"` backend
	 * launches. Overrides per-OS auto-discovery. Also settable via
	 * `--studioPath` or the `JEST_ROBLOX_STUDIO_PATH` environment variable.
	 */
	studioPath?: string;
	/**
	 * The Jest options block. Every jest-passthrough setting lives here, kept
	 * separate from the CLI/runner keys above.
	 */
	test?: GlobalTestConfig;
	/**
	 * Deadline in milliseconds Roblox is given to run the script. Default
	 * `300000`.
	 *
	 * The run is not abandoned the instant this elapses. Roblox starts the
	 * deadline when the script begins running, which is after the place boots,
	 * so the poll waits a fixed allowance past it for Roblox's own verdict —
	 * without that wait the run reports a poll timeout for a failure Roblox
	 * already described.
	 */
	timeout?: number;
	/** Open Cloud universe id that owns the place. */
	universeId?: string;
	/**
	 * Skip the place upload when the place file's bytes already have a version
	 * on Roblox, recorded in `.jest-roblox/upload-cache.json`. An upload is the
	 * only thing measured to precede a cold place boot, so an unchanged build
	 * keeps the warm path. Default `true`.
	 */
	uploadCache?: boolean;
	/**
	 * Workspace-mode knobs for multi-package runs. Ignored outside
	 * `--workspace`.
	 */
	workspace?: WorkspaceConfig;
}

/**
 * Relaxes optional properties to accept an explicit `undefined`.
 *
 * Only for internal, already-resolved shapes. The authoring surface (`Config`
 * and friends) must stay strict: `validateConfig` counts keys with
 * `Object.keys` and the arktype schema rejects unknown/misplaced ones, so a
 * present-but-undefined key there is a validation error, not a no-op.
 * Homomorphic (`[K in keyof T]`) so each property keeps its source JSDoc on
 * hover, same as `ConfigInput`.
 *
 * @template T - Object type whose optional properties are relaxed.
 */
export type UndefinedTolerant<T> = { [K in keyof T]: T[K] | undefined };

/**
 * A concurrency count as the CLI and config accept it: an explicit number, or
 * `"auto"` to let the layer that runs the work pick.
 */
export type ParallelCount = "auto" | number;

/**
 * Resolved config flattens the root CLI keys with the `test:` jest options
 * so downstream code (executor, projects, test-script, formatters) can read
 * options uniformly. Refactoring those consumers to read `config.test.foo`
 * is follow-up work; this representation lets the structural split land first.
 *
 * Its optional properties tolerate an explicit `undefined`: every producer
 * (`mergeCliWithConfig`, `narrowForLuauRun`) writes the key unconditionally,
 * and every consumer reads by value.
 */
export interface ResolvedConfig
	extends
		UndefinedTolerant<Except<Config, "test">>,
		UndefinedTolerant<Except<GlobalTestConfig, "projects">> {
	/** Execution backend. */
	backend: Backend;
	/** Boot probe budget in milliseconds. */
	bootProbeTimeout: number;
	/** Collect code coverage during the run. */
	collectCoverage: boolean;
	/** Collect coverage per test. */
	collectPerTestCoverage?: boolean | undefined;
	/** Force ANSI colour in output. */
	color: boolean;
	/** Reuse the instrumented coverage place between runs. */
	coverageCache: boolean;
	/** Globs for files a coverage run does not copy into the place. */
	coverageCopyIgnorePatterns: Array<string>;
	/** Directory coverage reports are written to. */
	coverageDirectory: string;
	/** Globs excluded from coverage collection. */
	coveragePathIgnorePatterns: Array<string>;
	/** Istanbul reporters to emit. */
	coverageReporters: Array<CoverageReporter>;
	/**
	 * Studio-only, experimental: the VM count `--experimental-vm-parallel`
	 * asked for. Sourced from the CLI alone — {@link Config} has no such key,
	 * so a config file cannot turn in-session parallelism on for everyone who
	 * runs the suite.
	 */
	experimentalVmParallel?: ParallelCount | undefined;
	/**
	 * `true` is expanded to `<rootDir>/game-output.log` at resolve time; an
	 * explicit path is kept as-is.
	 */
	gameOutput?: string | undefined;
	/**
	 * `true` is expanded to `<rootDir>/jest-output.log` at resolve time; an
	 * explicit path is kept as-is.
	 */
	outputFile?: string | undefined;
	/** Exit `0` even when no tests are found. */
	passWithNoTests: boolean;
	/** Path to the `.rbxl` place, relative to `rootDir`. */
	placeFile: string;
	/** WebSocket port for the Studio backend. */
	port: number;
	/**
	 * The `projects` entries as authored. Resolution turns each into a
	 * `ResolvedProjectConfig`; this field keeps the raw form, because
	 * single/multi dispatch and workspace mode both read it before resolution
	 * runs.
	 */
	projects?: Array<ProjectEntry> | undefined;
	/** Budget in milliseconds for one project's whole Jest run. */
	projectTimeout: number;
	/** Absolute base directory for relative paths. */
	rootDir: string;
	/** Include the translated Luau line in error output. */
	showLuau: boolean;
	/** Suppress test console output. */
	silent: boolean;
	/** Map Luau stack traces back to TypeScript source. */
	sourceMap: boolean;
	/** Glob patterns that detect test files. */
	testMatch: Array<string>;
	/** Regex patterns of test file paths to skip. */
	testPathIgnorePatterns: Array<string>;
	/** Deadline in milliseconds Roblox is given to run the script. */
	timeout: number;
	/** Skip the place upload when the place is already uploaded. */
	uploadCache: boolean;
	/** Report each individual test result. */
	verbose: boolean;
}

/**
 * Settings atomic to one workspace invocation. The entire run uses one
 * value for each of these — there is no per-package variation. CLI flags
 * override per-package config; otherwise every selected package must agree.
 */
export interface WorkspaceRunOptions {
	/** Execution backend. */
	backend: Backend;
	/**
	 * Stop the run at the first failing package. CLI-only — there is no config
	 * counterpart, so a package cannot opt its workspace into failing fast.
	 */
	bail: boolean;
	/** Force ANSI colour in output. */
	color: boolean;
	/**
	 * Studio-only, experimental: how many Luau VMs one package's projects split
	 * across. CLI-only, like `bail`.
	 */
	experimentalVmParallel?: ParallelCount | undefined;
	/** Output formatters. */
	formatters: Array<FormatterEntry>;
	/** Absolute path for the Aggregated Game Output file; undefined = off. */
	gameOutput?: string;
	/** Run the `studio-cli` Studio hidden. */
	hiddenDesktop?: boolean;
	/** Absolute path for the aggregated result file; undefined = off. */
	outputFile?: string;
	/** Number of places to shard the run across, or `"auto"`. */
	parallel?: "auto" | number;
	/** Open Cloud place id. */
	placeId?: string;
	/** Absolute Studio plugins folder path. */
	pluginsDirectory?: string;
	/** WebSocket port for the Studio backend. */
	port: number;
	/** Suppress test console output. */
	silent: boolean;
	/**
	 * Studio executable override for the `studio-cli` backend; undefined =
	 * auto-discover.
	 */
	studioPath?: string;
	/** Open Cloud universe id. */
	universeId?: string;
	/**
	 * When true, emit Per-package Game Output files under
	 * `.jest-roblox/output/`.
	 */
	workspaceGameOutput: boolean;
	/**
	 * When true, emit per-package result files under `.jest-roblox/output/`.
	 */
	workspaceOutputFile: boolean;
}

/**
 * Resolve a config's `placeFile` against its `rootDir` to an absolute path.
 * The one resolution every backend shares: `placeFile` is rootDir-relative,
 * and a coverage run has the run layer point it at the instrumented place.
 *
 * @param config - Resolved config to read.
 * @returns Absolute place file path.
 */
export function resolvePlaceFilePath(config: ResolvedConfig): string {
	return path.resolve(config.rootDir, config.placeFile);
}

export const DEFAULT_CONFIG: ResolvedConfig = {
	backend: "auto",
	bootProbeTimeout: 90_000,
	collectCoverage: false,
	color: true,
	coverageCache: true,
	// The three sidecars roblox-ts emits beside every compiled module. rojo
	// mounts none of these extensions, and every stage that wants a source map
	// opens the one in `outDir`: the source mapper resolves `$path` from the
	// user's own rojo project, never the synthesized one, and the coverage
	// manifest records `sourceMapPath` against the source root. On a
	// game-sized tree they are three quarters of the mirrored files.
	coverageCopyIgnorePatterns: ["**/*.d.ts", "**/*.d.ts.map", "**/*.luau.map"],
	coverageDirectory: "coverage",
	coveragePathIgnorePatterns: [
		"**/*.spec.lua",
		"**/*.spec.luau",
		"**/*.test.lua",
		"**/*.test.luau",
		"**/node_modules/**",
		"**/rbxts_include/**",
	],
	coverageReporters: ["text", "lcov"],
	passWithNoTests: false,
	placeFile: "./game.rbxl",
	port: 3001,
	projectTimeout: 60_000,
	rootDir: process.cwd(),
	showLuau: true,
	silent: false,
	sourceMap: true,
	testMatch: [
		"**/*.spec.ts",
		"**/*.spec.tsx",
		"**/*.test.ts",
		"**/*.test.tsx",
		"**/*.spec-d.ts",
		"**/*.test-d.ts",
		"**/*.spec-d.luau",
		"**/*.test-d.luau",
		"**/*.spec.lua",
		"**/*.spec.luau",
		"**/*.test.lua",
		"**/*.test.luau",
	],
	testPathIgnorePatterns: ["/node_modules/", "/dist/", "/out/"],
	timeout: 300_000,
	uploadCache: true,
	verbose: false,
};

/** Options parsed from the command line. */
export interface CliOptions {
	/** Run only tests affected by changes since this git ref. */
	affectedSince?: string | undefined;
	/** Open Cloud API key. */
	apiKey?: string | undefined;
	/** Execution backend. */
	backend?: Backend | undefined;
	/**
	 * Workspace mode: stop the run as soon as a package fails (`--bail`).
	 * CLI-only, and distinct from Jest's own `test.bail`, which counts
	 * failing test suites inside a single package.
	 */
	bail?: boolean | undefined;
	/** Collect code coverage. */
	collectCoverage?: boolean | undefined;
	/** Globs selecting coverage source files. */
	collectCoverageFrom?: Array<string> | undefined;
	/** Force ANSI colour in output. */
	color?: boolean | undefined;

	/** Path to the config file. */
	config?: string | undefined;
	/** Reuse the instrumented coverage place between runs. */
	coverageCache?: boolean | undefined;
	/** Directory coverage reports are written to. */
	coverageDirectory?: string | undefined;
	/** Istanbul reporters to emit. */
	coverageReporters?: Array<CoverageReporter> | undefined;
	/**
	 * Studio-only, experimental (`--experimental-vm-parallel [n]`): run the
	 * multi-project configs across `n` Luau VMs inside one Studio session
	 * (`"auto"` = one VM per config). CLI-only — there is no config
	 * counterpart, because the DataModel contention it exposes is a property
	 * of the machine running it, not of the suite.
	 */
	experimentalVmParallel?: ParallelCount | undefined;
	/** Test file paths given as positional arguments. */
	files?: Array<string> | undefined;
	/** Output formatter names. */
	formatters?: Array<string> | undefined;
	/** Where to write Game Output. */
	gameOutput?: string | undefined;
	/**
	 * Show the Studio window during a `studio-cli` run (`--headed`). CLI-only;
	 * inert for every other backend. Never sourced from config or env.
	 */
	headed?: boolean | undefined;
	/** Print help and exit. */
	help?: boolean | undefined;
	/** Run the `studio-cli` Studio hidden. */
	hiddenDesktop?: boolean | undefined;
	/** Where to write the Jest result JSON. */
	outputFile?: string | undefined;
	/** Packages to select in workspace mode. */
	packages?: string | undefined;
	/** Number of places to shard the run across, or `"auto"`. */
	parallel?: "auto" | number | undefined;
	/** Exit `0` even when no tests are found. */
	passWithNoTests?: boolean | undefined;
	/** Open Cloud place id. */
	placeId?: string | undefined;
	/** WebSocket port for the Studio backend. */
	port?: number | undefined;
	/** Names of the projects to run. */
	project?: Array<string> | undefined;
	/**
	 * Source files of `related <files...>`: run only the Runtime Tests that
	 * reach one of them.
	 */
	related?: Array<string> | undefined;
	/** Reporter modules used to format results. */
	reporters?: Array<string> | undefined;
	/** Path to the Rojo project file. */
	rojoProject?: string | undefined;
	/** Scripts run before the test framework is installed. */
	setupFiles?: Array<string> | undefined;
	/** Scripts run after the test framework is installed. */
	setupFilesAfterEnv?: Array<string> | undefined;
	/** Include the translated Luau line in error output. */
	showLuau?: boolean | undefined;
	/** Suppress test console output. */
	silent?: boolean | undefined;
	/** Map Luau stack traces back to TypeScript source. */
	sourceMap?: boolean | undefined;
	/** Path to the Roblox Studio executable. */
	studioPath?: string | undefined;
	/** Run only tests whose full name matches this regex. */
	testNamePattern?: string | undefined;
	/** Run only test files whose path matches this regex. */
	testPathPattern?: string | undefined;
	/** Deadline in milliseconds Roblox is given to run the script. */
	timeout?: number | undefined;
	/** Run Type Tests too. */
	typecheck?: boolean | undefined;
	/** Run only Type Tests. */
	typecheckOnly?: boolean | undefined;
	/** Tsconfig path for Type Tests. */
	typecheckTsconfig?: string | undefined;
	/** Open Cloud universe id. */
	universeId?: string | undefined;
	/** Update stored snapshots. */
	updateSnapshot?: boolean | undefined;
	/** Skip the place upload when the place is already uploaded. */
	uploadCache?: boolean | undefined;
	/** Report each individual test result. */
	verbose?: boolean | undefined;
	/** Print the version and exit. */
	version?: boolean | undefined;
	/** Run in workspace mode. */
	workspace?: boolean | undefined;
	/**
	 * Directory to load the workspace config from when run outside a package.
	 */
	workspaceRoot?: string | undefined;
}
