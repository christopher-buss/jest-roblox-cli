import { type, type Type } from "arktype";
import { createDefineConfig } from "c12";
import type { ReportOptions } from "istanbul-reports";
import process from "node:process";
import type { Except } from "type-fest";

export type Backend = "auto" | "open-cloud" | "studio";

export type CoverageReporter = keyof ReportOptions;

export type FormatterEntry = [string, Record<string, unknown>] | string;

export interface SnapshotFormatOptions {
	callToJSON?: boolean;
	escapeRegex?: boolean;
	escapeString?: boolean;
	indent?: number;
	maxDepth?: number;
	min?: boolean;
	printBasicPrototype?: boolean;
	printFunctionName?: boolean;
}

export interface DisplayName {
	name: string;
	color: string;
}

/** Jest-passthrough keys valid both at `test:` and per-project. */
export interface SharedTestConfig {
	automock?: boolean;
	clearMocks?: boolean;
	injectGlobals?: boolean;
	mockDataModel?: boolean;
	resetMocks?: boolean;
	resetModules?: boolean;
	restoreMocks?: boolean;
	setupFiles?: Array<string>;
	setupFilesAfterEnv?: Array<string>;
	slowTestThreshold?: number;
	snapshotFormat?: SnapshotFormatOptions;
	snapshotSerializers?: Array<string>;
	testEnvironment?: string;
	testEnvironmentOptions?: Record<string, unknown> | string;
	testMatch?: Array<string>;
	testPathIgnorePatterns?: Array<string>;
	testRegex?: Array<string> | string;
	testTimeout?: number;
}

/** Jest-passthrough keys valid only per-project (under `projects[N].test`). */
export interface ProjectTestConfig extends SharedTestConfig {
	displayName: DisplayName | string;
	exclude?: Array<string>;
	include: Array<string>;
	outDir?: string;
	root?: string;
}

export interface InlineProjectConfig {
	test: ProjectTestConfig;
}

export type ProjectEntry = InlineProjectConfig | string;

/** Jest-passthrough keys valid only at root `test:` (not per-project). */
export interface GlobalTestConfig extends SharedTestConfig {
	all?: boolean;
	bail?: boolean | number;
	changedSince?: string;
	ci?: boolean;
	clearCache?: boolean;
	collectCoverage?: boolean;
	collectCoverageFrom?: Array<string>;
	coverage?: boolean;
	coverageDirectory?: string;
	coveragePathIgnorePatterns?: Array<string>;
	coverageReporters?: Array<CoverageReporter>;
	coverageThreshold?: {
		branches?: number;
		functions?: number;
		lines?: number;
		statements?: number;
	};
	debug?: boolean;
	env?: string;
	expand?: boolean;
	globals?: string;
	maxWorkers?: number | string;
	noStackTrace?: boolean;
	passWithNoTests?: boolean;
	preset?: string;
	projects?: Array<ProjectEntry>;
	reporters?: Array<string>;
	roots?: Array<string>;
	runInBand?: boolean;
	selectProjects?: Array<string>;
	showConfig?: boolean;
	silent?: boolean;
	testFailureExitCode?: string;
	testNamePattern?: string;
	testPathPattern?: string;
	timers?: string;
	updateSnapshot?: boolean;
	verbose?: boolean;
}

/**
 * Root-level config: CLI/runner keys plus the `test:` block where all
 * jest-passthrough options live.
 */
export interface Config {
	backend?: Backend;
	cache?: boolean;
	color?: boolean;
	extends?: Array<string> | string;
	formatters?: Array<FormatterEntry>;
	gameOutput?: string;
	jestPath?: string;
	luauRoots?: Array<string>;
	outputFile?: string;
	parallel?: "auto" | number;
	placeFile?: string;
	placeId?: string;
	pollInterval?: number;
	port?: number;
	rojoProject?: string;
	rootDir?: string;
	showLuau?: boolean;
	sourceMap?: boolean;
	test?: GlobalTestConfig;
	timeout?: number;
	typecheck?: boolean;
	typecheckOnly?: boolean;
	typecheckTsconfig?: string;
	universeId?: string;
}

/**
 * Resolved config flattens the root CLI keys with the `test:` jest options
 * so downstream code (executor, projects, test-script, formatters) can read
 * options uniformly. Refactoring those consumers to read `config.test.foo`
 * is HAL-167 follow-up work; this shape lets the structural split land first.
 */
export interface ResolvedConfig
	extends Except<Config, "test">, Except<GlobalTestConfig, "projects"> {
	backend: Backend;
	cache: boolean;
	collectCoverage: boolean;
	color: boolean;
	coverageDirectory: string;
	coveragePathIgnorePatterns: Array<string>;
	coverageReporters: Array<CoverageReporter>;
	passWithNoTests: boolean;
	placeFile: string;
	pollInterval: number;
	port: number;
	projects?: Array<string>;
	rootDir: string;
	showLuau: boolean;
	silent: boolean;
	sourceMap: boolean;
	testMatch: Array<string>;
	testPathIgnorePatterns: Array<string>;
	timeout: number;
	typecheck: boolean;
	typecheckOnly: boolean;
	typecheckTsconfig?: string;
	verbose: boolean;
}

type MergerFunction<T> = (defaults: T) => T;

type Mergeable<T> = MergerFunction<T> | T;

export const VALID_BACKENDS: ReadonlySet<string> = new Set<Backend>([
	"auto",
	"open-cloud",
	"studio",
]);

export function isValidBackend(value: string): value is Backend {
	return VALID_BACKENDS.has(value);
}

export const DEFAULT_CONFIG: ResolvedConfig = {
	backend: "auto",
	cache: true,
	collectCoverage: false,
	color: true,
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
	pollInterval: 500,
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
	typecheck: false,
	typecheckOnly: false,
	verbose: false,
};

export interface CliOptions {
	apiKey?: string;
	backend?: Backend;
	cache?: boolean;
	collectCoverage?: boolean;
	collectCoverageFrom?: Array<string>;
	color?: boolean;

	config?: string;
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
	pollInterval?: number;
	port?: number;
	project?: Array<string>;
	reporters?: Array<string>;
	rojoProject?: string;
	setupFiles?: Array<string>;
	setupFilesAfterEnv?: Array<string>;
	showLuau?: boolean;
	silent?: boolean;
	sourceMap?: boolean;
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
	"slowTestThreshold?": "number",
	"snapshotFormat?": snapshotFormatSchema,
	"snapshotSerializers?": "string[]",
	"testEnvironment?": "string",
	"testEnvironmentOptions?": type("string").or(type("object")),
	"testMatch?": "string[]",
	"testPathIgnorePatterns?": "string[]",
	"testRegex?": type("string").or(type("string[]")),
	"testTimeout?": "number",
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
	"env?": "string",
	"expand?": "boolean",
	"globals?": "string",
	"maxWorkers?": type("number").or(type("string")),
	"noStackTrace?": "boolean",
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
	"backend?": type("'auto'|'open-cloud'|'studio'"),
	"cache?": "boolean",
	"color?": "boolean",
	"config?": "string",
	"extends?": type("string").or(type("string[]")),
	"formatters?": formatterEntrySchema.array(),
	"gameOutput?": "string",
	"jestPath?": "string",
	"luauRoots?": "string[]",
	"outputFile?": "string",
	"parallel?": type("'auto'").or("number.integer >= 1"),
	"placeFile?": "string",
	"placeId?": "string",
	"pollInterval?": "number",
	"port?": "number",
	"rojoProject?": "string",
	"rootDir?": "string",
	"showLuau?": "boolean",
	"sourceMap?": "boolean",
	"test?": globalTestConfigSchema,
	"timeout?": "number",
	"typecheck?": "boolean",
	"typecheckOnly?": "boolean",
	"typecheckTsconfig?": "string",
	"universeId?": "string",
}).as<Config>();

export type GlobalTestConfigInput = Except<GlobalTestConfig, MergeableTestKey> & {
	[K in MergeableTestKey]?: Mergeable<NonNullable<GlobalTestConfig[K]>>;
};

export interface ConfigInput extends Except<Config, "formatters" | "luauRoots" | "test"> {
	formatters?: Mergeable<Array<FormatterEntry>>;
	luauRoots?: Mergeable<Array<string>>;
	test?: GlobalTestConfigInput;
}

export type RootCliKey = Exclude<keyof Config, "test">;

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

type GlobalOnlyKey = Exclude<keyof GlobalTestConfig, keyof SharedTestConfig>;

type SharedKey = keyof SharedTestConfig;

export const ROOT_CLI_KEYS_LIST: ReadonlyArray<RootCliKey> = [
	"backend",
	"cache",
	"color",
	"extends",
	"formatters",
	"gameOutput",
	"jestPath",
	"luauRoots",
	"outputFile",
	"parallel",
	"placeFile",
	"placeId",
	"pollInterval",
	"port",
	"rojoProject",
	"rootDir",
	"showLuau",
	"sourceMap",
	"timeout",
	"typecheck",
	"typecheckOnly",
	"typecheckTsconfig",
	"universeId",
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

export const SHARED_TEST_KEYS: ReadonlySet<string> = new Set<SharedKey>(SHARED_TEST_KEYS_LIST);

/** Keys valid in `test:` (root) but not per-project (`projects[N].test`). */
export const GLOBAL_TEST_KEYS: ReadonlySet<string> = new Set<GlobalOnlyKey>(GLOBAL_ONLY_KEYS_LIST);

/** Root-level CLI/runner keys. The complement of `test:` jest-passthrough keys. */
export const ROOT_CLI_KEYS: ReadonlySet<string> = new Set<RootCliKey>(ROOT_CLI_KEYS_LIST);

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
	"coverageDirectory",
	"coveragePathIgnorePatterns",
	"coverageReporters",
	"coverageThreshold",
]);

/**
 * Source of truth for jest-passthrough vs CLI key partitioning.  Used by
 * `validateConfig` to emit a migration error when jest options appear at
 * config root.
 */
export const KEY_LOCATIONS: Readonly<Record<string, "root" | "test">> = (() => {
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

	return result;
}

export const defineConfig: (input: ConfigInput) => ConfigInput = createDefineConfig<ConfigInput>();

export const defineProject: (input: InlineProjectConfig) => InlineProjectConfig =
	createDefineConfig<InlineProjectConfig>();
