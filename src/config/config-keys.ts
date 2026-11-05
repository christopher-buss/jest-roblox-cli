import type { Config, GlobalTestConfig, ProjectTestConfig, SharedTestConfig } from "./schema.ts";

type RootCliKey = Exclude<keyof Config, "test">;

type GlobalOnlyKey = Exclude<keyof GlobalTestConfig, keyof SharedTestConfig>;

type SharedKey = keyof SharedTestConfig;

export const ROOT_CLI_KEYS_LIST: ReadonlyArray<RootCliKey> = [
	"backend",
	"bootProbeTimeout",
	"color",
	"coverageCache",
	"extends",
	"formatters",
	"gameOutput",
	"hiddenDesktop",
	"jestPath",
	"luauRoots",
	"outputFile",
	"parallel",
	"placeFile",
	"placeId",
	"pluginsDirectory",
	"port",
	"rojoProject",
	"rootDir",
	"showLuau",
	"sourceMap",
	"studioPath",
	"timeout",
	"universeId",
	"uploadCache",
	"workspace",
];

const SHARED_TEST_KEYS_LIST = [
	"automock",
	"clearMocks",
	"injectGlobals",
	"mockDataModel",
	"projectTimeout",
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
	"coverageCopyIgnorePatterns",
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

/**
 * Root-level CLI/runner keys. The complement of `test:` jest-passthrough keys.
 */
export const ROOT_CLI_KEYS: ReadonlySet<string> = new Set<RootCliKey>(ROOT_CLI_KEYS_LIST);

/**
 * Keys valid per-project (`projects[N].test`). Used to filter `ResolvedConfig`
 * when generating stubs.
 */
export const PROJECT_TEST_KEYS: ReadonlySet<string> = new Set<keyof ProjectTestConfig>(
	PROJECT_TEST_KEYS_LIST,
);

/**
 * Keys excluded from jest argv when building the test runner script. Includes
 * all CLI/runner-level keys plus the coverage keys, which live under `test:`
 * by configuration layout but are consumed by the runner's lute-based coverage
 * layer (not jest itself).
 */
export const JEST_ARGV_EXCLUDED_KEYS: ReadonlySet<string> = new Set<string>([
	...ROOT_CLI_KEYS_LIST,
	"collectCoverage",
	"collectCoverageFrom",
	"collectPerTestCoverage",
	"coverageCopyIgnorePatterns",
	"coverageDirectory",
	"coveragePathIgnorePatterns",
	"coverageReporters",
	"coverageThreshold",
	// CLI-only, and not in `Config`, so `ROOT_CLI_KEYS_LIST` cannot carry it:
	// it tells the plugin how many VMs to run, and means nothing to Jest.
	"experimentalVmParallel",
	// Read by our own runner, not by Jest — it reaches the runtime as
	// `runnerTimeoutMs` instead. See `buildJestArgv`.
	"projectTimeout",
	"typecheck",
]);

/**
 * Removed flat root keys mapped to their `test.typecheck.*` replacements.
 * `assertNoLegacyKeys` emits a migration error naming these so upgraders see
 * the targets, mirroring the "wrap jest options in a `test:` block" directive.
 */
/**
 * Source of truth for jest-passthrough vs CLI key partitioning.  Used by
 * `assertNoLegacyKeys` to emit a migration error when jest options appear at
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
