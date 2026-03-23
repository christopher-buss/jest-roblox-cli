import { describe, expectTypeOf, it } from "vitest";

import type {
	Backend,
	BackendOptions,
	CliOptions,
	Config,
	ConfigInput,
	ExecuteOptions,
	ExecuteResult,
	GameOutputEntry,
	JestArgv,
	JestResult,
	OpenCloudBackend,
	ResolvedConfig,
	StudioBackend,
	TestCaseResult,
	TestDefinition,
	TestFileResult,
	TestStatus,
	TscErrorInfo,
	TypecheckOptions,
} from "./index.ts";
import {
	buildJestArgv,
	createOpenCloudBackend,
	createStudioBackend,
	DEFAULT_CONFIG,
	defineConfig,
	execute,
	extractJsonFromOutput,
	formatGameOutputNotice,
	formatJson,
	formatResult,
	formatTestSummary,
	generateTestScript,
	loadConfig,
	parseGameOutput,
	parseJestOutput,
	resolveConfig,
	runTypecheck,
	writeGameOutput,
	writeJsonFile,
} from "./index.ts";

describe("defineConfig", () => {
	it("should accept empty config", () => {
		expectTypeOf(defineConfig).toBeCallableWith({});
	});

	it("should accept valid backend literals", () => {
		expectTypeOf(defineConfig).toBeCallableWith({ backend: "auto" });
		expectTypeOf(defineConfig).toBeCallableWith({ backend: "studio" });
		expectTypeOf(defineConfig).toBeCallableWith({ backend: "open-cloud" });
	});

	it("should reject invalid backend values", () => {
		// @ts-expect-error "invalid" is not a valid Backend
		defineConfig({ backend: "invalid" });
	});

	it("should accept nested optional properties", () => {
		expectTypeOf(defineConfig).toBeCallableWith({
			coverageThreshold: { branches: 80 },
		});
	});

	it("should return ConfigInput (with c12 layer props)", () => {
		expectTypeOf(defineConfig).returns.toExtend<ConfigInput>();
	});

	it("should accept ConfigInput parameter (with c12 layer props)", () => {
		expectTypeOf(defineConfig).parameter(0).toExtend<ConfigInput>();
	});
});

describe("DEFAULT_CONFIG", () => {
	it("should be a ResolvedConfig", () => {
		expectTypeOf(DEFAULT_CONFIG).toExtend<ResolvedConfig>();
	});

	it("should have backend typed as string literal union", () => {
		expectTypeOf<ResolvedConfig["backend"]>().toEqualTypeOf<"auto" | "open-cloud" | "studio">();
	});
});

describe("resolveConfig", () => {
	it("should accept Config and return ResolvedConfig", () => {
		expectTypeOf(resolveConfig).parameter(0).toExtend<Config>();
		expectTypeOf(resolveConfig).returns.toEqualTypeOf<ResolvedConfig>();
	});
});

describe("loadConfig", () => {
	it("should return Promise<ResolvedConfig>", () => {
		expectTypeOf(loadConfig).returns.toEqualTypeOf<Promise<ResolvedConfig>>();
	});

	it("should accept optional configPath and cwd", () => {
		expectTypeOf(loadConfig).toBeCallableWith();
		expectTypeOf(loadConfig).toBeCallableWith("path");
		expectTypeOf(loadConfig).toBeCallableWith("path", "cwd");
	});

	it("should reject non-string arguments", () => {
		// @ts-expect-error number is not a valid config path
		void loadConfig(123);
	});
});

describe("execute", () => {
	it("should accept ExecuteOptions and return Promise<ExecuteResult>", () => {
		expectTypeOf(execute).parameter(0).toExtend<ExecuteOptions>();
		expectTypeOf(execute).returns.toEqualTypeOf<Promise<ExecuteResult>>();
	});
});

describe("ExecuteResult", () => {
	it("should have required fields", () => {
		expectTypeOf<ExecuteResult>().toHaveProperty("exitCode");
		expectTypeOf<ExecuteResult>().toHaveProperty("output");
		expectTypeOf<ExecuteResult>().toHaveProperty("result");
	});

	it("should have optional coverageData", () => {
		expectTypeOf<ExecuteResult["coverageData"]>().toBeNullable();
	});
});

describe("formatters", () => {
	it("should return strings from formatResult", () => {
		expectTypeOf(formatResult).returns.toBeString();
	});

	it("should return strings from formatTestSummary", () => {
		expectTypeOf(formatTestSummary).returns.toBeString();
	});

	it("should return strings from formatJson", () => {
		expectTypeOf(formatJson).returns.toBeString();
	});

	it("should return void promise from writeJsonFile", () => {
		expectTypeOf(writeJsonFile).returns.toEqualTypeOf<Promise<void>>();
	});
});

describe("parsers", () => {
	it("should accept string in parseJestOutput", () => {
		expectTypeOf(parseJestOutput).parameter(0).toBeString();
	});

	it("should return string or undefined from extractJsonFromOutput", () => {
		expectTypeOf(extractJsonFromOutput).returns.toEqualTypeOf<string | undefined>();
	});
});

describe("test-script", () => {
	it("should accept BackendOptions in buildJestArgv", () => {
		expectTypeOf(buildJestArgv).parameter(0).toExtend<BackendOptions>();
	});

	it("should return JestArgv from buildJestArgv", () => {
		expectTypeOf(buildJestArgv).returns.toExtend<JestArgv>();
	});

	it("should return string from generateTestScript", () => {
		expectTypeOf(generateTestScript).returns.toBeString();
	});
});

describe("backends", () => {
	it("should implement Backend interface", () => {
		expectTypeOf<OpenCloudBackend>().toExtend<Backend>();
		expectTypeOf<StudioBackend>().toExtend<Backend>();
	});

	it("should return backend instances from factory functions", () => {
		expectTypeOf(createOpenCloudBackend).returns.toExtend<Backend>();
		expectTypeOf(createStudioBackend).returns.toExtend<Backend>();
	});
});

describe("runTypecheck", () => {
	it("should accept TypecheckOptions and return JestResult", () => {
		expectTypeOf(runTypecheck).parameter(0).toExtend<TypecheckOptions>();
		expectTypeOf(runTypecheck).returns.toEqualTypeOf<JestResult>();
	});
});

describe("game-output utilities", () => {
	it("should return string from formatGameOutputNotice", () => {
		expectTypeOf(formatGameOutputNotice).returns.toBeString();
	});

	it("should return GameOutputEntry array from parseGameOutput", () => {
		expectTypeOf(parseGameOutput).returns.toEqualTypeOf<Array<GameOutputEntry>>();
	});

	it("should return void from writeGameOutput", () => {
		expectTypeOf(writeGameOutput).returns.toBeVoid();
	});
});

describe("type exports", () => {
	it("should export TestStatus as string literal union", () => {
		expectTypeOf<TestStatus>().toExtend<string>();
	});

	it("should export TestCaseResult with required fields", () => {
		expectTypeOf<TestCaseResult>().toHaveProperty("fullName");
		expectTypeOf<TestCaseResult>().toHaveProperty("status");
		expectTypeOf<TestCaseResult>().toHaveProperty("title");
	});

	it("should export TestFileResult with required fields", () => {
		expectTypeOf<TestFileResult>().toHaveProperty("testFilePath");
		expectTypeOf<TestFileResult>().toHaveProperty("testResults");
	});

	it("should export JestResult with required fields", () => {
		expectTypeOf<JestResult>().toHaveProperty("success");
		expectTypeOf<JestResult>().toHaveProperty("testResults");
		expectTypeOf<JestResult>().toHaveProperty("numTotalTests");
	});

	it("should export TestDefinition with required fields", () => {
		expectTypeOf<TestDefinition>().toHaveProperty("name");
		expectTypeOf<TestDefinition>().toHaveProperty("type");
	});

	it("should export TscErrorInfo with required fields", () => {
		expectTypeOf<TscErrorInfo>().toHaveProperty("filePath");
		expectTypeOf<TscErrorInfo>().toHaveProperty("line");
		expectTypeOf<TscErrorInfo>().toHaveProperty("errorMessage");
	});

	it("should export CliOptions with optional fields", () => {
		expectTypeOf<CliOptions>().toBeObject();
	});
});
