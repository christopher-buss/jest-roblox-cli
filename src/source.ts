// `source`-condition entry for workspace typecheck (tsconfig `customConditions:
// ["source"]`). Mirrors the config + artifact slice of the public API that
// workspace consumers resolve from source — config files import `defineConfig`,
// mutation-tester imports the artifact contract. It deliberately omits the
// CLI/runtime modules in `index.ts` (the dist entry) because those import
// `.luau` assets that only resolve inside this package's own build. The runtime
// producer API (`prepareArtifacts`, `loadConfig`, …) is consumed from the built
// `dist` `.d.ts` via the `./artifacts` subpath export, not from source, so its
// `.luau` graph never enters a consumer's typecheck.
export {
	GLOBAL_TEST_KEYS,
	JEST_ARGV_EXCLUDED_KEYS,
	PROJECT_TEST_KEYS,
	ROOT_CLI_KEYS,
	ROOT_CLI_KEYS_LIST,
	SHARED_TEST_KEYS,
} from "./config/config-keys.ts";
export {
	absolutePathSchema,
	configSchema,
	projectConfigFileSchema,
	validateConfig,
	validateConfigLayer,
} from "./config/config-validation.ts";
export { type ConfigInput, defineConfig, defineProject } from "./config/define-config.ts";
export {
	isCoverageReporter,
	isValidBackend,
	VALID_BACKENDS,
	VALID_COVERAGE_REPORTERS,
} from "./config/option-values.ts";
export {
	type Backend,
	type CliOptions,
	type Config,
	type CoverageReporter,
	DEFAULT_CONFIG,
	type DisplayName,
	type FormatterEntry,
	type GlobalTestConfig,
	type InlineProjectConfig,
	type ParallelCount,
	type ProjectConfigFile,
	type ProjectEntry,
	type ProjectTestConfig,
	resolvePlaceFilePath,
	type ResolvedConfig,
	type SharedTestConfig,
	type SnapshotFormatOptions,
	type UndefinedTolerant,
	type WorkspaceConfig,
	type WorkspaceRunOptions,
} from "./config/schema.ts";
export * from "./coverage-pipeline/artifacts.ts";
