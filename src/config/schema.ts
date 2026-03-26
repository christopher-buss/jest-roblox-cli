import type { Argv } from "@rbxts/jest/src/config";

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

export const ROOT_ONLY_KEYS: ReadonlySet<string> = new Set([
	"backend",
	"cache",
	"collectCoverage",
	"collectCoverageFrom",
	"coverageDirectory",
	"coveragePathIgnorePatterns",
	"coverageReporters",
	"coverageThreshold",
	"formatters",
	"gameOutput",
	"jestPath",
	"luauRoots",
	"placeFile",
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
]);

export interface DisplayName {
	name: string;
	color: string;
}

export interface ProjectTestConfig {
	automock?: boolean;
	clearMocks?: boolean;
	displayName: DisplayName | string;
	exclude?: Array<string>;
	include: Array<string>;
	injectGlobals?: boolean;
	mockDataModel?: boolean;
	outDir?: string;
	resetMocks?: boolean;
	resetModules?: boolean;
	restoreMocks?: boolean;
	root?: string;
	setupFiles?: Array<string>;
	setupFilesAfterEnv?: Array<string>;
	slowTestThreshold?: number;
	snapshotFormat?: SnapshotFormatOptions;
	snapshotSerializers?: Array<string>;
	testEnvironment?: string;
	testEnvironmentOptions?: Record<string, unknown>;
	testMatch?: Array<string>;
	testPathIgnorePatterns?: Array<string>;
	testRegex?: Array<string> | string;
	testTimeout?: number;
}

export interface InlineProjectConfig {
	test: ProjectTestConfig;
}

export type ProjectEntry = InlineProjectConfig | string;

export interface Config extends Except<
	Argv,
	"projects" | "rootDir" | "setupFiles" | "setupFilesAfterEnv" | "testPathPattern"
> {
	backend?: Backend;
	cache?: boolean;
	collectCoverage?: boolean;
	collectCoverageFrom?: Array<string>;

	coverageDirectory?: string;
	coveragePathIgnorePatterns?: Array<string>;
	coverageReporters?: Array<CoverageReporter>;
	coverageThreshold?: {
		branches?: number;
		functions?: number;
		lines?: number;
		statements?: number;
	};
	extends?: Array<string> | string;
	formatters?: Array<FormatterEntry>;
	gameOutput?: string;
	jestPath?: string;
	luauRoots?: Array<string>;
	passWithNoTests?: boolean;
	placeFile?: string;
	pollInterval?: number;
	port?: number;
	projects?: Array<ProjectEntry>;
	reporters?: Array<string>;
	rojoProject?: string;
	rootDir?: string;
	setupFiles?: Array<string>;
	setupFilesAfterEnv?: Array<string>;
	showLuau?: boolean;
	snapshotFormat?: SnapshotFormatOptions;
	sourceMap?: boolean;
	testPathPattern?: string;
	timeout?: number;
	typecheck?: boolean;
	typecheckOnly?: boolean;
	typecheckTsconfig?: string;
	updateSnapshot?: boolean;
}

export interface ResolvedConfig extends Except<Config, "projects"> {
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
	passWithNoTests?: boolean;
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
	updateSnapshot?: boolean;
	verbose?: boolean;
	version?: boolean;
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

const projectTestConfigSchema = type({
	"+": "reject",
	"automock?": "boolean",
	"clearMocks?": "boolean",
	"displayName": type("string").or(displayNameSchema),
	"exclude?": "string[]",
	"include": "string[]",
	"injectGlobals?": "boolean",
	"mockDataModel?": "boolean",
	"outDir?": "string",
	"resetMocks?": "boolean",
	"resetModules?": "boolean",
	"restoreMocks?": "boolean",
	"root?": "string",
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
});

const inlineProjectSchema = type({
	"+": "reject",
	"test": projectTestConfigSchema,
});

const formatterEntrySchema = type("string").or(type(["string", type("object")]));

const projectEntrySchema = type("string").or(inlineProjectSchema);

export const configSchema: Type<Config> = type({
	"+": "reject",
	"all?": "boolean",
	"automock?": "boolean",
	"backend?": type("'auto'|'open-cloud'|'studio'"),
	"bail?": type("boolean").or(type("number")),
	"cache?": "boolean",
	"changedSince?": "string",
	"ci?": "boolean",
	"clearCache?": "boolean",
	"clearMocks?": "boolean",
	"collectCoverage?": "boolean",
	"collectCoverageFrom?": "string[]",
	"color?": "boolean",
	"colors?": "boolean",
	"config?": "string",
	"coverage?": "boolean",
	"coverageDirectory?": "string",
	"coveragePathIgnorePatterns?": "string[]",
	"coverageReporters?": "string[]",
	"coverageThreshold?": coverageThresholdSchema,
	"debug?": "boolean",
	"env?": "string",
	"expand?": "boolean",
	"formatters?": formatterEntrySchema.array(),
	"gameOutput?": "string",
	"globals?": "string",
	"init?": "boolean",
	"injectGlobals?": "boolean",
	"jestPath?": "string",
	"luauRoots?": "string[]",
	"maxWorkers?": type("number").or(type("string")),
	"noStackTrace?": "boolean",
	"outputFile?": "string",
	"passWithNoTests?": "boolean",
	"placeFile?": "string",
	"pollInterval?": "number",
	"port?": "number",
	"preset?": "string",
	"projects?": projectEntrySchema.array(),
	"reporters?": "string[]",
	"resetMocks?": "boolean",
	"resetModules?": "boolean",
	"restoreMocks?": "boolean",
	"rojoProject?": "string",
	"rootDir?": "string",
	"roots?": "string[]",
	"runInBand?": "boolean",
	"selectProjects?": "string[]",
	"setupFiles?": "string[]",
	"setupFilesAfterEnv?": "string[]",
	"showConfig?": "boolean",
	"showLuau?": "boolean",
	"silent?": "boolean",
	"snapshotFormat?": snapshotFormatSchema,
	"snapshotSerializers?": "string[]",
	"sourceMap?": "boolean",
	"testEnvironment?": "string",
	"testEnvironmentOptions?": type("string").or(type("object")),
	"testFailureExitCode?": "string",
	"testMatch?": "string[]",
	"testNamePattern?": "string",
	"testPathIgnorePatterns?": "string[]",
	"testPathPattern?": "string",
	"testRegex?": type("string").or(type("string[]")),
	"testTimeout?": "number",
	"timeout?": "number",
	"timers?": "string",
	"typecheck?": "boolean",
	"typecheckOnly?": "boolean",
	"typecheckTsconfig?": "string",
	"updateSnapshot?": "boolean",
	"verbose?": "boolean",
	"version?": "boolean",
}).as<Config>();

export interface ConfigInput extends Except<
	Config,
	| "collectCoverageFrom"
	| "coveragePathIgnorePatterns"
	| "coverageReporters"
	| "formatters"
	| "luauRoots"
	| "reporters"
	| "setupFiles"
	| "setupFilesAfterEnv"
	| "testMatch"
	| "testPathIgnorePatterns"
> {
	collectCoverageFrom?: Mergeable<Array<string>>;
	coveragePathIgnorePatterns?: Mergeable<Array<string>>;
	coverageReporters?: Mergeable<Array<CoverageReporter>>;
	formatters?: Mergeable<Array<FormatterEntry>>;
	luauRoots?: Mergeable<Array<string>>;
	reporters?: Mergeable<Array<string>>;
	setupFiles?: Mergeable<Array<string>>;
	setupFilesAfterEnv?: Mergeable<Array<string>>;
	testMatch?: Mergeable<Array<string>>;
	testPathIgnorePatterns?: Mergeable<Array<string>>;
}

export function validateConfig(raw: unknown): Config {
	const result = configSchema(raw);
	if (result instanceof type.errors) {
		throw new Error(`Invalid config: ${result.summary}`);
	}

	return result;
}

export const defineConfig: (input: ConfigInput) => ConfigInput = createDefineConfig<ConfigInput>();

export const defineProject: (input: ProjectTestConfig) => ProjectTestConfig =
	createDefineConfig<ProjectTestConfig>();
