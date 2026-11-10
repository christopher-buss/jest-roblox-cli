import * as path from "node:path";
import process from "node:process";
import type { Except } from "type-fest";

import { RUN_TIMEOUT_MS } from "../protocol/limits.ts";
import { DEFAULT_STUDIO_PORT } from "../protocol/studio.ts";
import type {
	BackendName,
	Config,
	CoverageReporter,
	GlobalTestConfig,
	ProjectEntry,
} from "./config-types.ts";
import type { FormatterEntry, FormatterName } from "./formatter-selection.ts";

/**
 * Lets optional properties take `undefined`. Never on `Config`: its validation
 * rejects present-but-undefined keys.
 *
 * @template T - Object type whose optional properties are relaxed.
 */
export type UndefinedTolerant<T> = { [K in keyof T]: T[K] | undefined };

/** A concurrency count, or `"auto"`. */
export type ParallelCount = "auto" | number;

/** Root config keys and `test:` options, flattened. */
export interface ResolvedConfig
	extends
		UndefinedTolerant<Except<Config, "test">>,
		UndefinedTolerant<Except<GlobalTestConfig, "projects">> {
	/** Execution backend. */
	backend: BackendName;
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
	/** Studio-only, CLI-only: VM count from `--experimental-vm-parallel`. */
	experimentalVmParallel?: ParallelCount | undefined;
	/** Game Output file path. */
	gameOutput?: string | undefined;
	/** Jest result file path. */
	outputFile?: string | undefined;
	/** Exit `0` even when no tests are found. */
	passWithNoTests: boolean;
	/** Path to the `.rbxl` place, relative to `rootDir`. */
	placeFile: string;
	/** WebSocket port for the Studio backend. */
	port: number;
	/** The `projects` entries as authored, before resolution. */
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

/** Settings with one value across a whole workspace run. */
export interface WorkspaceRunOptions {
	/** Execution backend. */
	backend: BackendName;
	/** Stop the run at the first failing package. */
	bail: boolean;
	/** Boot probe budget in milliseconds. */
	bootProbeTimeout: number;
	/** Force ANSI colour in output. */
	color: boolean;
	/** Studio-only: Luau VM count one package's projects split across. */
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
	/** Include the translated Luau line in error output. */
	showLuau: boolean;
	/** Suppress test console output. */
	silent: boolean;
	/** Seconds after which a single test is reported as slow. */
	slowTestThreshold?: number;
	/** Studio executable for `studio-cli`; undefined = auto-discover. */
	studioPath?: string;
	/** Run timeout in milliseconds for the Studio backends. */
	timeout: number;
	/** Open Cloud universe id. */
	universeId?: string;
	/** Skip the place upload when its bytes are unchanged. */
	uploadCache: boolean;
	/** Show individual test results. */
	verbose: boolean;
	/** Emit Per-package Game Output files. */
	workspaceGameOutput: boolean;
	/** Emit per-package result files. */
	workspaceOutputFile: boolean;
}

/**
 * Resolve a config's `placeFile` against its `rootDir`.
 *
 * @param config - Resolved config to read.
 * @returns Absolute place file path.
 */
export function resolvePlaceFilePath(
	config: Pick<ResolvedConfig, "placeFile" | "rootDir">,
): string {
	return path.resolve(config.rootDir, config.placeFile);
}

export const DEFAULT_CONFIG: ResolvedConfig = {
	backend: "auto",
	bootProbeTimeout: 90_000,
	collectCoverage: false,
	color: true,
	coverageCache: true,
	// Safe only while source maps are read from `outDir`, not the mirror.
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
	port: DEFAULT_STUDIO_PORT,
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
	timeout: RUN_TIMEOUT_MS,
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
	backend?: BackendName | undefined;
	/** Workspace mode: stop at the first failing package. */
	bail?: boolean | undefined;
	/** Bare --changed resolves to HEAD before git is invoked. */
	changed?: string | undefined;
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
	/** Studio-only: Luau VM count for multi-project configs. */
	experimentalVmParallel?: ParallelCount | undefined;
	/** Test file paths given as positional arguments. */
	files?: Array<string> | undefined;
	/** Output formatter names. */
	formatters?: Array<FormatterName> | undefined;
	/** Where to write Game Output. */
	gameOutput?: string | undefined;
	/** Show the Studio window during a `studio-cli` run. */
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
	 * Source paths resolve against the run root, independently of test
	 * filters.
	 */
	related?: Array<string> | undefined;
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
	/** Workspace config directory when run outside a package. */
	workspaceRoot?: string | undefined;
}
