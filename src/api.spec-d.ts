import { describe, expectTypeOf, it } from "vitest";

import type {
	ArtifactBundle,
	Backend,
	BuildManifest,
	CliOptions,
	Config,
	ConfigInput,
	CoverageManifest,
	ExecuteResult,
	FormattedExecuteResult,
	FormattedRunProjectsResult,
	InstrumentedFileRecord,
	JestResult,
	OpenCloudBackend,
	ProjectInput,
	ReadBuildManifestResult,
	ReadCoverageManifestResult,
	ResolvedConfig,
	RunProjectsOptions,
	TestCaseResult,
	TestFileResult,
	TestStatus,
	TypecheckOptions,
} from "./api.ts";
import {
	buildManifestSchema,
	coverageManifestSchema,
	DEFAULT_CONFIG,
	defineConfig,
	formatJson,
	formatResult,
	hashFile,
	loadConfig,
	prepareArtifactsAsync,
	readBuildManifest,
	readCoverageManifest,
	resolveConfig,
	resolveLayoutProject,
	runProjectsAsync,
	runTypecheckAsync,
} from "./api.ts";

describe(defineConfig, () => {
	it("should accept empty config", () => {
		expectTypeOf(defineConfig).toBeCallableWith({});
	});

	it("should accept valid backend literals", () => {
		expectTypeOf(defineConfig).toBeCallableWith({ backend: "auto" });
		expectTypeOf(defineConfig).toBeCallableWith({ backend: "studio" });
		expectTypeOf(defineConfig).toBeCallableWith({ backend: "open-cloud" });
	});

	it("should reject invalid backend values", () => {
		// @ts-expect-error "invalid" is not a valid BackendName
		defineConfig({ backend: "invalid" });
	});

	it("should accept nested optional properties", () => {
		expectTypeOf(defineConfig).toBeCallableWith({
			test: { coverageThreshold: { branches: 80 } },
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
		expectTypeOf<ResolvedConfig["backend"]>().toEqualTypeOf<
			"auto" | "open-cloud" | "studio" | "studio-cli"
		>();
	});
});

describe(resolveConfig, () => {
	it("should accept Config and return ResolvedConfig", () => {
		expectTypeOf(resolveConfig).parameter(0).toExtend<Config>();
		expectTypeOf(resolveConfig).returns.toEqualTypeOf<ResolvedConfig>();
	});
});

describe(resolveLayoutProject, () => {
	it("should give back the config the CLI runs", () => {
		expectTypeOf(resolveLayoutProject).returns.toEqualTypeOf<ResolvedConfig>();
	});
});

describe(loadConfig, () => {
	it("should return Promise<ResolvedConfig>", () => {
		expectTypeOf(loadConfig).returns.toEqualTypeOf<Promise<ResolvedConfig>>();
	});

	it("should accept optional configPath and cwd in one options object", () => {
		expectTypeOf(loadConfig).toBeCallableWith();
		expectTypeOf(loadConfig).toBeCallableWith({ configPath: "path" });
		expectTypeOf(loadConfig).toBeCallableWith({ configPath: "path", cwd: "cwd" });
	});

	it("should reject positional arguments", () => {
		// @ts-expect-error configPath moved into the options object
		void loadConfig("path", "cwd");
	});
});

describe(runProjectsAsync, () => {
	it("should accept RunProjectsOptions and return Promise<FormattedRunProjectsResult>", () => {
		expectTypeOf(runProjectsAsync).parameter(0).toExtend<RunProjectsOptions>();
		expectTypeOf(runProjectsAsync).returns.toEqualTypeOf<Promise<FormattedRunProjectsResult>>();
	});
});

describe("ProjectInput", () => {
	it("should require config and testFiles", () => {
		expectTypeOf<ProjectInput>().toHaveProperty("config");
		expectTypeOf<ProjectInput>().toHaveProperty("testFiles");
	});

	it("should expose optional displayColor, displayName, pkg", () => {
		expectTypeOf<ProjectInput["displayColor"]>().toBeNullable();
		expectTypeOf<ProjectInput["displayName"]>().toBeNullable();
		expectTypeOf<ProjectInput["pkg"]>().toBeNullable();
	});

	it("should be the element type of RunProjectsOptions.projects", () => {
		expectTypeOf<RunProjectsOptions["projects"]>().toEqualTypeOf<Array<ProjectInput>>();
	});
});

describe("ExecuteResult", () => {
	it("should have required fields", () => {
		expectTypeOf<ExecuteResult>().toHaveProperty("exitCode");
		expectTypeOf<FormattedExecuteResult>().toHaveProperty("output");
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

	it("should return strings from formatJson", () => {
		expectTypeOf(formatJson).returns.toBeString();
	});
});

describe(runTypecheckAsync, () => {
	it("should accept TypecheckOptions and return a Promise of JestResult", () => {
		expectTypeOf(runTypecheckAsync).parameter(0).toExtend<TypecheckOptions>();
		expectTypeOf(runTypecheckAsync).returns.toEqualTypeOf<Promise<JestResult>>();
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

	it("should export CliOptions with optional fields", () => {
		expectTypeOf<CliOptions>().toBeObject();
	});
});

describe("artifact contract", () => {
	it("should return a hex string from hashFile", () => {
		expectTypeOf(hashFile).parameter(0).toBeString();
		expectTypeOf(hashFile).returns.toBeString();
	});

	it("should return ReadBuildManifestResult from readBuildManifest", () => {
		expectTypeOf(readBuildManifest).returns.toEqualTypeOf<ReadBuildManifestResult>();
	});

	it("should return ReadCoverageManifestResult from readCoverageManifest", () => {
		expectTypeOf(readCoverageManifest).returns.toEqualTypeOf<ReadCoverageManifestResult>();
	});

	it("should expose the arktype schemas as callable validators", () => {
		expectTypeOf(buildManifestSchema).toBeCallableWith({});
		expectTypeOf(coverageManifestSchema).toBeCallableWith({});
	});

	it("should export BuildManifest with the cross-link and artifact fields", () => {
		expectTypeOf<BuildManifest>().toHaveProperty("buildId");
		expectTypeOf<BuildManifest>().toHaveProperty("cleanPlace");
		expectTypeOf<BuildManifest>().toHaveProperty("coveragePlace");
		expectTypeOf<BuildManifest>().toHaveProperty("files");
		expectTypeOf<BuildManifest>().toHaveProperty("projects");
	});

	it("should export CoverageManifest carrying the shared buildId", () => {
		expectTypeOf<CoverageManifest>().toHaveProperty("buildId");
		expectTypeOf<CoverageManifest["buildId"]>().toBeString();
	});

	it("should export InstrumentedFileRecord", () => {
		expectTypeOf<InstrumentedFileRecord>().toHaveProperty("sourceHash");
	});

	it("should expose prepareArtifactsAsync returning an ArtifactBundle", () => {
		expectTypeOf(prepareArtifactsAsync).returns.toEqualTypeOf<Promise<ArtifactBundle>>();
	});

	it("should export ArtifactBundle with both places and the manifest paths", () => {
		expectTypeOf<ArtifactBundle>().toHaveProperty("cleanPlace");
		expectTypeOf<ArtifactBundle>().toHaveProperty("coveragePlace");
		expectTypeOf<ArtifactBundle>().toHaveProperty("buildId");
		expectTypeOf<ArtifactBundle>().toHaveProperty("buildManifestPath");
		expectTypeOf<ArtifactBundle>().toHaveProperty("coverageManifestPath");
	});
});

describe("backends", () => {
	it("should implement the Backend interface", () => {
		expectTypeOf<OpenCloudBackend>().toExtend<Backend>();
	});
});
