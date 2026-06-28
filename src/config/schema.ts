import { type, type Type } from "arktype";
import { createDefineConfig } from "c12";
import type { ReportOptions } from "istanbul-reports";
import * as path from "node:path";
import process from "node:process";
import type { Except } from "type-fest";

import type { TypecheckConfig } from "./resolve-typecheck-config.ts";

export type Backend = "auto" | "open-cloud" | "studio" | "studio-cli";

export type CoverageReporter = keyof ReportOptions;

export type FormatterEntry = [string, Record<string, unknown>] | string;

/** pretty-format options controlling how snapshots are serialized. */
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
	 * Swap the live Roblox DataModel for a fresh mock instance per test file so
	 * tests can mutate the tree in isolation. Default `false`.
	 */
	mockDataModel?: boolean;
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
	/** DataModel paths to scripts run once before the test framework is installed. */
	setupFiles?: Array<string>;
	/**
	 * DataModel paths to scripts run after the framework is installed, before
	 * each test file — the place for global hooks and custom matchers.
	 */
	setupFilesAfterEnv?: Array<string>;
	/** Seconds after which a single test is reported as slow. Default `5`. */
	slowTestThreshold?: number;
	/** pretty-format options controlling how snapshots are serialized. */
	snapshotFormat?: SnapshotFormatOptions;
	/** DataModel paths to custom snapshot serializer modules. */
	snapshotSerializers?: Array<string>;
	/** Test environment used to run the tests. */
	testEnvironment?: string;
	/** Options forwarded to the test environment. */
	testEnvironmentOptions?: Record<string, unknown> | string;
	/** Glob patterns Jest uses to detect test files. */
	testMatch?: Array<string>;
	/** Regex patterns; a test file is skipped when its path matches any of them. */
	testPathIgnorePatterns?: Array<string>;
	/** Regex pattern(s) Jest uses to detect test files (alternative to `testMatch`). */
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
	 * Compiled-output directory the project's `.luau` lives in. Setting it pins
	 * the project to a single DataModel mount (exact Rojo lookup, no
	 * auto-expand). roblox-ts users point this at the compiled output (e.g.
	 * `"out/client"`), not `"src/…"`.
	 */
	outDir?: string;
	/** Base path prepended to this project's `include`, `exclude`, and `outDir`. */
	root?: string;
}

export interface InlineProjectConfig {
	test: ProjectTestConfig;
}

/** Workspace-only knobs. Ignored outside `--workspace` mode. */
export interface WorkspaceConfig {
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
	/** Alias for {@link collectCoverage}. */
	coverage?: boolean;
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
		branches?: number;
		functions?: number;
		lines?: number;
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
	/** Default compiled-output directory for test discovery when not set per-project. */
	outDir?: string;
	/** Exit `0` even when no tests are found. Default `false`. */
	passWithNoTests?: boolean;
	/** Name of a preset that supplies base Jest config. */
	preset?: string;
	/**
	 * Per-project configs for a multi-project run. Each entry is a DataModel
	 * path string, or an inline {@link defineProject} object.
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
	/** Report each individual test result, not just suite summaries. Default `false`. */
	verbose?: boolean;
}

/**
 * Root-level config: CLI/runner keys plus the `test:` block where all
 * jest-passthrough options live.
 */
export interface Config {
	/**
	 * Execution backend. `"auto"` probes for a running Studio then falls back to
	 * Open Cloud; `"open-cloud"` uploads and runs via Roblox Open Cloud;
	 * `"studio"` drives a locally running Studio; `"studio-cli"` launches its own
	 * headless Studio via `--task RunScript` and quits it. Default `"auto"`.
	 * `"studio-cli"` is never selected by `"auto"` — request it explicitly.
	 */
	backend?: Backend;
	/** Force ANSI colour in output. Default `true`. */
	color?: boolean;
	/**
	 * Reuse the incrementally-instrumented coverage place between runs when
	 * nothing changed. Default `true`.
	 */
	coverageCache?: boolean;
	/**
	 * One or more config files to inherit from (c12 layering), relative to this
	 * file. Local keys win over extended ones.
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
	/** Number of places to shard the run across, or `"auto"` to pick automatically. */
	parallel?: "auto" | number;
	/** Path to the `.rbxl` place uploaded and run. Default `"./game.rbxl"`. */
	placeFile?: string;
	/** Open Cloud place id to publish/run against. */
	placeId?: string;
	/** WebSocket port for the Studio backend. Default `3001`. */
	port?: number;
	/**
	 * Path to the Rojo project file used to map DataModel paths to source.
	 * Auto-detected when unset.
	 */
	rojoProject?: string;
	/**
	 * Base directory for resolving relative paths. Defaults to the current
	 * working directory.
	 */
	rootDir?: string;
	/** Include the translated Luau line in error/stack output. Default `true`. */
	showLuau?: boolean;
	/** Map Luau stack traces back to TypeScript source. Default `true`. */
	sourceMap?: boolean;
	/**
	 * Path to the Roblox Studio executable the `"studio-cli"` backend launches.
	 * Overrides per-OS auto-discovery. Also settable via `--studioPath` or the
	 * `JEST_ROBLOX_STUDIO_PATH` environment variable.
	 */
	studioPath?: string;
	/**
	 * The Jest options block. Every jest-passthrough setting lives here, kept
	 * separate from the CLI/runner keys above.
	 */
	test?: GlobalTestConfig;
	/**
	 * Maximum remote execution time in milliseconds before the run is
	 * abandoned. Default `300000`.
	 */
	timeout?: number;
	/** Open Cloud universe id that owns the place. */
	universeId?: string;
	/**
	 * Workspace-mode knobs for multi-package runs. Ignored outside
	 * `--workspace`.
	 */
	workspace?: WorkspaceConfig;
}

/**
 * Resolved config flattens the root CLI keys with the `test:` jest options
 * so downstream code (executor, projects, test-script, formatters) can read
 * options uniformly. Refactoring those consumers to read `config.test.foo`
 * is follow-up work; this shape lets the structural split land first.
 */
export interface ResolvedConfig
	extends Except<Config, "test">, Except<GlobalTestConfig, "projects"> {
	backend: Backend;
	collectCoverage: boolean;
	collectPerTestCoverage?: boolean;
	color: boolean;
	coverageCache: boolean;
	coverageDirectory: string;
	coveragePathIgnorePatterns: Array<string>;
	coverageReporters: Array<CoverageReporter>;
	/** `true` is expanded to `<rootDir>/game-output.log` at resolve time; an explicit path is kept as-is. */
	gameOutput?: string;
	/** `true` is expanded to `<rootDir>/jest-output.log` at resolve time; an explicit path is kept as-is. */
	outputFile?: string;
	passWithNoTests: boolean;
	placeFile: string;
	port: number;
	projects?: Array<string>;
	rootDir: string;
	showLuau: boolean;
	silent: boolean;
	sourceMap: boolean;
	testMatch: Array<string>;
	testPathIgnorePatterns: Array<string>;
	timeout: number;
	verbose: boolean;
}

/**
 * Settings atomic to one workspace invocation. The entire run uses one
 * value for each of these — there is no per-package variation. CLI flags
 * override per-package config; otherwise every selected package must agree.
 */
export interface WorkspaceRunOptions {
	backend: Backend;
	color: boolean;
	formatters: Array<FormatterEntry>;
	/** Absolute path for the Aggregated Game Output file; undefined = off. */
	gameOutput?: string;
	/** Absolute path for the aggregated result file; undefined = off. */
	outputFile?: string;
	parallel?: "auto" | number;
	placeId?: string;
	port: number;
	silent: boolean;
	/** Studio executable override for the `studio-cli` backend; undefined = auto-discover. */
	studioPath?: string;
	universeId?: string;
	/** When true, emit Per-package Game Output files under `.jest-roblox/output/`. */
	workspaceGameOutput: boolean;
	/** When true, emit per-package result files under `.jest-roblox/output/`. */
	workspaceOutputFile: boolean;
}

type MergerFunction<T> = (defaults: T) => T;

type Mergeable<T> = MergerFunction<T> | T;

export const VALID_BACKENDS: ReadonlySet<string> = new Set<Backend>([
	"auto",
	"open-cloud",
	"studio",
	"studio-cli",
]);

export function isValidBackend(value: string): value is Backend {
	return VALID_BACKENDS.has(value);
}

/**
 * Resolve a config's `placeFile` against its `rootDir` to an absolute path. The
 * one resolution every backend shares: `placeFile` is rootDir-relative, and a
 * coverage run has the run layer point it at the instrumented place.
 */
export function resolvePlaceFilePath(config: ResolvedConfig): string {
	return path.resolve(config.rootDir, config.placeFile);
}

export const DEFAULT_CONFIG: ResolvedConfig = {
	backend: "auto",
	collectCoverage: false,
	color: true,
	coverageCache: true,
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
		"**/*.spec.lua",
		"**/*.spec.luau",
		"**/*.test.lua",
		"**/*.test.luau",
	],
	testPathIgnorePatterns: ["/node_modules/", "/dist/", "/out/"],
	timeout: 300_000,
	verbose: false,
};

export interface CliOptions {
	affectedSince?: string;
	apiKey?: string;
	backend?: Backend;
	collectCoverage?: boolean;
	collectCoverageFrom?: Array<string>;
	color?: boolean;

	config?: string;
	coverageCache?: boolean;
	coverageDirectory?: string;
	coverageReporters?: Array<CoverageReporter>;
	files?: Array<string>;
	formatters?: Array<string>;
	gameOutput?: string;
	help?: boolean;
	outputFile?: string;
	packages?: string;
	parallel?: "auto" | number;
	passWithNoTests?: boolean;
	placeId?: string;
	port?: number;
	project?: Array<string>;
	reporters?: Array<string>;
	rojoProject?: string;
	setupFiles?: Array<string>;
	setupFilesAfterEnv?: Array<string>;
	showLuau?: boolean;
	silent?: boolean;
	sourceMap?: boolean;
	studioPath?: string;
	testNamePattern?: string;
	testPathPattern?: string;
	timeout?: number;
	typecheck?: boolean;
	typecheckOnly?: boolean;
	typecheckTsconfig?: string;
	universeId?: string;
	updateSnapshot?: boolean;
	verbose?: boolean;
	version?: boolean;
	workspace?: boolean;
	/** Directory to load the workspace config from when run outside a package. */
	workspaceRoot?: string;
}

const snapshotFormatSchema = type({
	"+": "reject",
	"callToJSON?": "boolean",
	"escapeRegex?": "boolean",
	"escapeString?": "boolean",
	"indent?": "number",
	"maxDepth?": "number",
	"min?": "boolean",
	"printBasicPrototype?": "boolean",
	"printFunctionName?": "boolean",
});

const coverageThresholdSchema = type({
	"+": "reject",
	"branches?": "number",
	"functions?": "number",
	"lines?": "number",
	"statements?": "number",
});

const displayNameSchema = type({
	"name": "string",
	"+": "reject",
	"color": "string",
});

const typecheckConfigSchema = type({
	"+": "reject",
	"enabled?": "boolean",
	"exclude?": "string[]",
	"ignoreSourceErrors?": "boolean",
	"include?": "string[]",
	"only?": "boolean",
	"spawnTimeout?": "number > 0",
	"tsconfig?": "string",
});

const sharedTestSchemaShape = {
	"automock?": "boolean",
	"clearMocks?": "boolean",
	"injectGlobals?": "boolean",
	"mockDataModel?": "boolean",
	"resetMocks?": "boolean",
	"resetModules?": "boolean",
	"restoreMocks?": "boolean",
	"setupFiles?": "string[]",
	"setupFilesAfterEnv?": "string[]",
	"slowTestThreshold?": "number > 0",
	"snapshotFormat?": snapshotFormatSchema,
	"snapshotSerializers?": "string[]",
	"testEnvironment?": "string",
	"testEnvironmentOptions?": type("string").or(type("object")),
	"testMatch?": "string[]",
	"testPathIgnorePatterns?": "string[]",
	"testRegex?": type("string").or(type("string[]")),
	"testTimeout?": "number",
	"typecheck?": typecheckConfigSchema,
} as const;

const projectTestConfigSchema = type({
	"+": "reject",
	...sharedTestSchemaShape,
	"displayName": type("string").or(displayNameSchema),
	"exclude?": "string[]",
	"include": "string[]",
	"outDir?": "string",
	"root?": "string",
});

const inlineProjectSchema = type({
	"+": "reject",
	"test": projectTestConfigSchema,
});

const workspaceConfigSchema = type({
	"+": "reject",
	"gameOutput?": "true",
	"outputFile?": "true",
	"packages?": "string[]",
	"root?": "string",
});

const formatterEntrySchema = type("string").or(type(["string", type("object")]));

const projectEntrySchema = type("string").or(inlineProjectSchema);

const globalTestConfigSchema = type({
	"+": "reject",
	...sharedTestSchemaShape,
	"all?": "boolean",
	"bail?": type("boolean").or(type("number")),
	"changedSince?": "string",
	"ci?": "boolean",
	"clearCache?": "boolean",
	"collectCoverage?": "boolean",
	"collectCoverageFrom?": "string[]",
	"coverage?": "boolean",
	"coverageDirectory?": "string",
	"coveragePathIgnorePatterns?": "string[]",
	"coverageReporters?": "string[]",
	"coverageThreshold?": coverageThresholdSchema,
	"debug?": "boolean",
	"displayName?": type("string").or(displayNameSchema),
	"env?": "string",
	"exclude?": "string[]",
	"expand?": "boolean",
	"globals?": "string",
	"include?": "string[]",
	"maxWorkers?": type("number").or(type("string")),
	"noStackTrace?": "boolean",
	"outDir?": "string",
	"passWithNoTests?": "boolean",
	"preset?": "string",
	"projects?": projectEntrySchema.array(),
	"reporters?": "string[]",
	"roots?": "string[]",
	"runInBand?": "boolean",
	"selectProjects?": "string[]",
	"showConfig?": "boolean",
	"silent?": "boolean",
	"testFailureExitCode?": "string",
	"testNamePattern?": "string",
	"testPathPattern?": "string",
	"timers?": "string",
	"updateSnapshot?": "boolean",
	"verbose?": "boolean",
});

export const configSchema: Type<Config> = type({
	"+": "reject",
	"backend?": type("'auto'|'open-cloud'|'studio'|'studio-cli'"),
	"color?": "boolean",
	"config?": "string",
	"coverageCache?": "boolean",
	"extends?": type("string").or(type("string[]")),
	"formatters?": formatterEntrySchema.array(),
	"gameOutput?": type("string").or("true"),
	"jestPath?": "string",
	"luauRoots?": "string[]",
	"outputFile?": type("string").or("true"),
	"parallel?": type("'auto'").or("number.integer >= 1"),
	"placeFile?": "string",
	"placeId?": "string",
	"port?": "number",
	"rojoProject?": "string",
	"rootDir?": "string",
	"showLuau?": "boolean",
	"sourceMap?": "boolean",
	"studioPath?": "string",
	"test?": globalTestConfigSchema,
	"timeout?": "number",
	"universeId?": "string",
	"workspace?": workspaceConfigSchema,
}).as<Config>();

// Homomorphic (`[K in keyof T]`) so each property's JSDoc is preserved on
// hover in a `defineConfig({ … })` literal — the mergeable keys still relax
// to accept a `(defaults) => merged` function, but TypeScript forwards the
// source doc comment.
export type ConfigInput = {
	[K in keyof Config]?: K extends "formatters"
		? Mergeable<Array<FormatterEntry>>
		: K extends "luauRoots"
			? Mergeable<Array<string>>
			: K extends "test"
				? GlobalTestConfigInput
				: Config[K];
};

type MergeableTestKey =
	| "collectCoverageFrom"
	| "coveragePathIgnorePatterns"
	| "coverageReporters"
	| "coverageThreshold"
	| "reporters"
	| "roots"
	| "selectProjects"
	| "setupFiles"
	| "setupFilesAfterEnv"
	| "snapshotFormat"
	| "snapshotSerializers"
	| "testMatch"
	| "testPathIgnorePatterns";

// Homomorphic for the same JSDoc-preservation reason as `ConfigInput`; the
// mergeable keys relax to `Mergeable<…>` while every key keeps its source doc.
type GlobalTestConfigInput = {
	[K in keyof GlobalTestConfig]?: K extends MergeableTestKey
		? Mergeable<NonNullable<GlobalTestConfig[K]>>
		: GlobalTestConfig[K];
};

type RootCliKey = Exclude<keyof Config, "test">;

type GlobalOnlyKey = Exclude<keyof GlobalTestConfig, keyof SharedTestConfig>;

type SharedKey = keyof SharedTestConfig;

export const ROOT_CLI_KEYS_LIST: ReadonlyArray<RootCliKey> = [
	"backend",
	"color",
	"coverageCache",
	"extends",
	"formatters",
	"gameOutput",
	"jestPath",
	"luauRoots",
	"outputFile",
	"parallel",
	"placeFile",
	"placeId",
	"port",
	"rojoProject",
	"rootDir",
	"showLuau",
	"sourceMap",
	"studioPath",
	"timeout",
	"universeId",
	"workspace",
];

const SHARED_TEST_KEYS_LIST = [
	"automock",
	"clearMocks",
	"injectGlobals",
	"mockDataModel",
	"resetMocks",
	"resetModules",
	"restoreMocks",
	"setupFiles",
	"setupFilesAfterEnv",
	"slowTestThreshold",
	"snapshotFormat",
	"snapshotSerializers",
	"testEnvironment",
	"testEnvironmentOptions",
	"testMatch",
	"testPathIgnorePatterns",
	"testRegex",
	"testTimeout",
	"typecheck",
] as const satisfies ReadonlyArray<SharedKey>;

const GLOBAL_ONLY_KEYS_LIST = [
	"all",
	"bail",
	"changedSince",
	"ci",
	"clearCache",
	"collectCoverage",
	"collectCoverageFrom",
	"coverage",
	"coverageDirectory",
	"coveragePathIgnorePatterns",
	"coverageReporters",
	"coverageThreshold",
	"debug",
	"env",
	"expand",
	"globals",
	"maxWorkers",
	"noStackTrace",
	"passWithNoTests",
	"preset",
	"projects",
	"reporters",
	"roots",
	"runInBand",
	"selectProjects",
	"showConfig",
	"silent",
	"testFailureExitCode",
	"testNamePattern",
	"testPathPattern",
	"timers",
	"updateSnapshot",
	"verbose",
] as const satisfies ReadonlyArray<GlobalOnlyKey>;

// Keep in sync with `ProjectTestConfig`: any new field added there must
// also be listed here to appear in generated stubs (`satisfies` checks
// membership, not exhaustiveness).
const PROJECT_TEST_KEYS_LIST = [
	...SHARED_TEST_KEYS_LIST,
	"displayName",
	"exclude",
	"include",
	"outDir",
	"root",
] as const satisfies ReadonlyArray<keyof ProjectTestConfig>;

export const SHARED_TEST_KEYS: ReadonlySet<string> = new Set<SharedKey>(SHARED_TEST_KEYS_LIST);

/** Keys valid in `test:` (root) but not per-project (`projects[N].test`). */
export const GLOBAL_TEST_KEYS: ReadonlySet<string> = new Set<GlobalOnlyKey>(GLOBAL_ONLY_KEYS_LIST);

/** Root-level CLI/runner keys. The complement of `test:` jest-passthrough keys. */
export const ROOT_CLI_KEYS: ReadonlySet<string> = new Set<RootCliKey>(ROOT_CLI_KEYS_LIST);

/** Keys valid per-project (`projects[N].test`). Used to filter `ResolvedConfig` when generating stubs. */
export const PROJECT_TEST_KEYS: ReadonlySet<string> = new Set<keyof ProjectTestConfig>(
	PROJECT_TEST_KEYS_LIST,
);

/**
 * Keys excluded from jest argv when building the test runner script. Includes
 * all CLI/runner-level keys plus the coverage keys, which live under `test:`
 * by config shape but are consumed by the runner's lute-based coverage layer
 * (not jest itself).
 */
export const JEST_ARGV_EXCLUDED_KEYS: ReadonlySet<string> = new Set<string>([
	...ROOT_CLI_KEYS_LIST,
	"collectCoverage",
	"collectCoverageFrom",
	"collectPerTestCoverage",
	"coverageDirectory",
	"coveragePathIgnorePatterns",
	"coverageReporters",
	"coverageThreshold",
	"typecheck",
]);

/**
 * Removed flat root keys mapped to their `test.typecheck.*` replacements.
 * `validateConfig` emits a migration error naming these so upgraders see the
 * targets, mirroring the "wrap jest options in a `test:` block" directive.
 */
const MIGRATED_TYPECHECK_KEYS: Readonly<Record<string, string>> = {
	typecheck: "test.typecheck.enabled",
	typecheckOnly: "test.typecheck.only",
	typecheckTsconfig: "test.typecheck.tsconfig",
};

/**
 * Source of truth for jest-passthrough vs CLI key partitioning.  Used by
 * `validateConfig` to emit a migration error when jest options appear at
 * config root.
 */
const KEY_LOCATIONS: Readonly<Record<string, "root" | "test">> = (() => {
	const result: Record<string, "root" | "test"> = {};
	for (const key of ROOT_CLI_KEYS_LIST) {
		result[key] = "root";
	}

	for (const key of SHARED_TEST_KEYS_LIST) {
		result[key] = "test";
	}

	for (const key of GLOBAL_ONLY_KEYS_LIST) {
		result[key] = "test";
	}

	return result;
})();

export function validateConfig(raw: unknown): Config {
	if (typeof raw === "object" && raw !== null) {
		const migrated = Object.keys(raw)
			.filter((key) => key in MIGRATED_TYPECHECK_KEYS)
			.sort();
		if (migrated.length > 0) {
			const targets = migrated
				.map((key) => `${key} → ${MIGRATED_TYPECHECK_KEYS[key]}`)
				.join(", ");
			throw new Error(
				`\`typecheck\` options have moved under \`test.typecheck\`. Replace these keys: ${targets}`,
			);
		}

		const misplaced = Object.keys(raw)
			.filter((key) => KEY_LOCATIONS[key] === "test")
			.sort();
		if (misplaced.length > 0) {
			throw new Error(
				`jest options must be wrapped in a \`test:\` block. Move these keys under \`test:\`: ${misplaced.join(", ")}`,
			);
		}
	}

	const result = configSchema(raw);
	if (result instanceof type.errors) {
		throw new Error(`Invalid config: ${result.summary}`);
	}

	const { workspace } = result;
	if (
		workspace !== undefined &&
		(workspace.root === undefined) !== (workspace.packages === undefined)
	) {
		throw new Error("workspace.root and workspace.packages must be declared together.");
	}

	return result;
}

/**
 * Identity helper for authoring a typed `jest.config.*` file. Returns its
 * input unchanged; it exists purely to give editors autocompletion and
 * type-checking for the root config shape (`Config` plus the c12 layer props
 * on `ConfigInput`).
 *
 * Use it as the default export of a config file discovered by c12 (`.ts`,
 * `.js`, `.mjs`, `.cjs`, `.json`, `.yaml`, `.toml`). All jest-passthrough
 * options live under the `test:` block; root keys are CLI/runner-level.
 * Configs may extend a shared base via `extends`, and any `Mergeable` array
 * field (e.g. `test.testMatch`) accepts a function that receives the inherited
 * defaults and returns the merged value. Precedence is CLI flags > config file
 * > extended config > defaults.
 */
export const defineConfig: (input: ConfigInput) => ConfigInput = createDefineConfig<ConfigInput>();

/**
 * Identity helper for a single entry inside `test.projects`, mirroring
 * {@link defineConfig} for per-project overrides. Returns its input unchanged
 * and exists only for editor autocompletion and type-checking of the
 * `InlineProjectConfig` shape — a `test:` block carrying the project's
 * `include`/`displayName` plus any shared per-project jest options.
 */
export const defineProject: (input: InlineProjectConfig) => InlineProjectConfig =
	createDefineConfig<InlineProjectConfig>();
