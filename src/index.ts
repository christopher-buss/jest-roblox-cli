// Config files load this entry through jiti under the `source` condition, so no
// module it reaches may import a `.luau` file.
export type {
	BackendName,
	Config,
	CoverageReporter,
	DisplayName,
	GlobalTestConfig,
	InlineProjectConfig,
	ProjectConfigFile,
	ProjectEntry,
	ProjectTestConfig,
	SharedTestConfig,
	SnapshotFormatOptions,
	WorkspaceConfig,
} from "./config/config-types.ts";
export { type ConfigInput, defineConfig, defineProject } from "./config/define-config.ts";
export type {
	AgentFormatterOptions,
	FormatterEntry,
	FormatterName,
	GitHubActionsFormatterOptions,
} from "./config/formatter-selection.ts";
export type { CliOptions, ResolvedConfig } from "./config/resolved-config.ts";
export * from "./coverage-data/artifacts.ts";
export type { RawCoverageData, RawFileCoverage } from "./coverage-data/coverage-types.ts";
export type { ProjectResult, RunResult } from "./results/run-result-types.ts";
export type {
	JestResult,
	TestCaseResult,
	TestFileResult,
	TestStatus,
} from "./types/jest-result-types.ts";
