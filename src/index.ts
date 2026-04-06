export type { Backend, BackendOptions } from "./backends/interface.ts";
export { OpenCloudBackend, createOpenCloudBackend } from "./backends/open-cloud.ts";
export { StudioBackend, createStudioBackend } from "./backends/studio.ts";
export { loadConfig, resolveConfig } from "./config/loader.ts";

export type { ResolvedProjectConfig } from "./config/projects.ts";

export type {
	Config,
	ConfigInput,
	FormatterEntry,
	ResolvedConfig,
	CliOptions,
	ProjectTestConfig,
	InlineProjectConfig,
	ProjectEntry,
	DisplayName,
} from "./config/schema.ts";
export { DEFAULT_CONFIG, defineConfig, defineProject, ROOT_ONLY_KEYS } from "./config/schema.ts";
export { execute, formatExecuteOutput } from "./executor.ts";
export type { ExecuteOptions, ExecuteResult, FormatOutputOptions } from "./executor.ts";

export { formatResult, formatTestSummary, formatFailure } from "./formatters/formatter.ts";
export { formatAnnotations, formatJobSummary } from "./formatters/github-actions.ts";
export type { GitHubActionsFormatterOptions } from "./formatters/github-actions.ts";

export { formatJson, writeJsonFile } from "./formatters/json.ts";
export { parseJestOutput, extractJsonFromOutput } from "./reporter/parser.ts";

export { buildJestArgv, generateTestScript } from "./test-script.ts";

export type { JestArgv } from "./test-script.ts";
export { runTypecheck } from "./typecheck/runner.ts";
export type { TypecheckOptions } from "./typecheck/runner.ts";
export type { TestDefinition, TscErrorInfo } from "./typecheck/types.ts";
export type { GameOutputEntry } from "./types/game-output.ts";
export type {
	JestResult,
	TestFileResult,
	TestCaseResult,
	TestStatus,
} from "./types/jest-result.ts";
export { formatGameOutputNotice, parseGameOutput, writeGameOutput } from "./utils/game-output.ts";

// Luau AST infrastructure
export type {
	AstExpr,
	AstExprBinary,
	AstExprCall,
	AstExprFunction,
	AstStat,
	AstStatBlock,
	LuauSpan,
	LuauVisitor,
} from "@isentinel/luau-ast";
export { visitBlock, visitExpression, visitStatement } from "@isentinel/luau-ast";
