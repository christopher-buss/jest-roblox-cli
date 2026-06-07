import { type, type Type } from "arktype";
import { createDefineConfig } from "c12";
import type { ReportOptions } from "istanbul-reports";
import process from "node:process";
import type { Except } from "type-fest";

import type { TypecheckConfig } from "./resolve-typecheck-config.ts";

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
	/**
	 * Host-only Type Test config. Never forwarded to the Roblox runtime.
	 * Resolved per-project via `resolveTypecheckConfig`.
	 */
	typecheck?: TypecheckConfig;
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
	displayName?: DisplayName | string;
	env?: string;
	exclude?: Array<string>;
	expand?: boolean;
	globals?: string;
	include?: Array<string>;
	maxWorkers?: number | string;
	noStackTrace?: boolean;
	outDir?: string;
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
	color?: boolean;
	coverageCache?: boolean;
	extends?: Array<string> | string;
	formatters?: Array<FormatterEntry>;
	/**
	 * Where to write Game Output. A path, or `true` to default to
	 * `game-output.log` under the root. In workspace mode this becomes the
	 * single Aggregated Game Output file (consensus-resolved).
	 */
	gameOutput?: string | true;
	jestPath?: string;
	luauRoots?: Array<string>;
	/**
	 * Where to write the Jest result JSON. A path, or `true` to default to
	 * `jest-output.log` under the root. In workspace mode this becomes the
	 * single aggregated result file (consensus-resolved).
	 */
	outputFile?: string | true;
	parallel?: "auto" | number;
	placeFile?: string;
	placeId?: string;
	port?: number;
	rojoProject?: string;
	rootDir?: string;
	showLuau?: boolean;
	sourceMap?: boolean;
	test?: GlobalTestConfig;
	timeout?: number;
	universeId?: string;
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
]);

export function isValidBackend(value: string): value is Backend {
	return VALID_BACKENDS.has(value);
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
	"include?": "string[]",
	"only?": "boolean",
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
	"backend?": type("'auto'|'open-cloud'|'studio'"),
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
	"test?": globalTestConfigSchema,
	"timeout?": "number",
	"universeId?": "string",
	"workspace?": workspaceConfigSchema,
}).as<Config>();

export interface ConfigInput extends Except<Config, "formatters" | "luauRoots" | "test"> {
	formatters?: Mergeable<Array<FormatterEntry>>;
	luauRoots?: Mergeable<Array<string>>;
	test?: GlobalTestConfigInput;
}

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

type GlobalTestConfigInput = Except<GlobalTestConfig, MergeableTestKey> & {
	[K in MergeableTestKey]?: Mergeable<NonNullable<GlobalTestConfig[K]>>;
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

export const defineConfig: (input: ConfigInput) => ConfigInput = createDefineConfig<ConfigInput>();

export const defineProject: (input: InlineProjectConfig) => InlineProjectConfig =
	createDefineConfig<InlineProjectConfig>();
