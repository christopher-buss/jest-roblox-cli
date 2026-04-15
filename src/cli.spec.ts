import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import process from "node:process";
import type { MockInstance } from "vitest";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { resolveBackend } from "./backends/auto.ts";
import type { Backend, BackendResult, ProjectJob } from "./backends/interface.ts";
import { filterByName, main, mergeProjectResults, parseArgs, run } from "./cli.ts";
import { ConfigError } from "./config/errors.ts";
import { loadConfig } from "./config/loader.ts";
import type { ResolvedProjectConfig } from "./config/projects.ts";
import { resolveAllProjects } from "./config/projects.ts";
import {
	DEFAULT_CONFIG,
	type InlineProjectConfig,
	type ProjectEntry,
	type ResolvedConfig,
} from "./config/schema.ts";
import { createSetupResolver } from "./config/setup-resolver.ts";
import { generateProjectConfigs, syncStubsToShadowDirectory } from "./config/stubs.ts";
import { mapCoverageToTypeScript } from "./coverage/mapper.ts";
import { prepareCoverage } from "./coverage/prepare.ts";
import { checkThresholds, generateReports } from "./coverage/reporter.ts";
import { buildWithRojo } from "./coverage/rojo-builder.ts";
import {
	buildProjectJob,
	execute,
	executeBackend,
	type ExecuteResult,
	formatExecuteOutput,
	loadCoverageManifest,
	processProjectResult,
} from "./executor.ts";
import { writeJsonFile } from "./formatters/json.ts";
import { LuauScriptError } from "./reporter/parser.ts";
import type { SourceMapper } from "./source-mapper/index.ts";
import { runTypecheck } from "./typecheck/runner.ts";
import type { JestResult } from "./types/jest-result.ts";
import { formatGameOutputNotice, parseGameOutput, writeGameOutput } from "./utils/game-output.ts";
import { globSync } from "./utils/glob.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

vi.mock(import("./backends/auto"));
vi.mock(import("./config/loader"));
vi.mock(import("./config/projects"));
vi.mock(import("./config/setup-resolver"));
vi.mock(import("./config/stubs"));
vi.mock(import("./coverage/rojo-builder"));
vi.mock(import("./executor"));
vi.mock(import("./coverage/prepare"));
vi.mock(import("./coverage/mapper"));
vi.mock(import("./coverage/reporter"));
vi.mock(import("./typecheck/runner"));
vi.mock(import("./utils/glob"));
vi.mock(import("./utils/game-output"));
vi.mock(import("./formatters/json"));

const stdEnvironmentMock = vi.hoisted(() => ({ isAgent: false }));
vi.mock(import("std-env"), async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		get isAgent() {
			return stdEnvironmentMock.isAgent;
		},
	};
});

type MockedWrite = MockInstance<typeof process.stderr.write>;

type MockedConsole = MockInstance<typeof console.log>;

interface OutputSpies {
	consoleError: MockedConsole;
	consoleLog: MockedConsole;
	stderr: MockedWrite;
	stdout: MockedWrite;
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...DEFAULT_CONFIG,
		rootDir: "/test",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

function makeJestResult(overrides: Partial<JestResult> = {}): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: 1000,
		success: true,
		testResults: [],
		...overrides,
	};
}

function makeExecuteResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
	return {
		exitCode: 0,
		output: "",
		result: makeJestResult(),
		timing: {
			executionMs: 100,
			startTime: Date.now(),
			testsMs: 50,
			totalMs: 200,
			uploadCached: false,
			uploadMs: 50,
		},
		...overrides,
	};
}

function makeBackendResult(jobs: Array<ProjectJob>): BackendResult {
	return {
		results: jobs.map((job) => {
			return {
				displayColor: job.displayColor,
				displayName: job.displayName,
				elapsedMs: 50,
				result: makeJestResult(),
			};
		}),
		timing: { executionMs: 100, uploadCached: false, uploadMs: 50 },
	};
}

function makeMockBackend(kind: "open-cloud" | "studio" = "studio"): Backend {
	return {
		close: vi.fn<NonNullable<Backend["close"]>>(),
		kind,
		runTests: vi.fn<Backend["runTests"]>(),
	};
}

const mocks = {
	buildProjectJob: vi.mocked(buildProjectJob),
	buildWithRojo: vi.mocked(buildWithRojo),
	checkThresholds: vi.mocked(checkThresholds),
	createSetupResolver: vi.mocked(createSetupResolver),
	execute: vi.mocked(execute),
	executeBackend: vi.mocked(executeBackend),
	formatExecuteOutput: vi.mocked(formatExecuteOutput),
	formatGameOutputNotice: vi.mocked(formatGameOutputNotice),
	generateProjectConfigs: vi.mocked(generateProjectConfigs),
	generateReports: vi.mocked(generateReports),
	globSync: vi.mocked(globSync),
	loadConfig: vi.mocked(loadConfig),
	loadCoverageManifest: vi.mocked(loadCoverageManifest),
	mapCoverageToTypeScript: vi.mocked(mapCoverageToTypeScript),
	parseGameOutput: vi.mocked(parseGameOutput),
	prepareCoverage: vi.mocked(prepareCoverage),
	processProjectResult: vi.mocked(processProjectResult),
	resolveAllProjects: vi.mocked(resolveAllProjects),
	resolveBackend: vi.mocked(resolveBackend),
	runTypecheck: vi.mocked(runTypecheck),
	syncStubsToShadowDirectory: vi.mocked(syncStubsToShadowDirectory),
	writeGameOutput: vi.mocked(writeGameOutput),
	writeJsonFile: vi.mocked(writeJsonFile),
};

function setupAgentDetection(isAgent: boolean) {
	stdEnvironmentMock.isAgent = isAgent;
	onTestFinished(() => {
		stdEnvironmentMock.isAgent = false;
	});
}

/** Set up default mocks that make runInner succeed with runtime tests */
function setupDefaults(configOverrides: Partial<ResolvedConfig> = {}) {
	const config = makeConfig(configOverrides);

	mocks.loadConfig.mockResolvedValue(config);
	mocks.globSync.mockReturnValue(["/test/foo.spec.ts"]);
	mocks.resolveBackend.mockResolvedValue({} as never);
	mocks.execute.mockResolvedValue(makeExecuteResult());
	mocks.formatExecuteOutput.mockReturnValue("");
	mocks.parseGameOutput.mockReturnValue([]);
	mocks.formatGameOutputNotice.mockReturnValue("");
	mocks.loadCoverageManifest.mockReturnValue(undefined);

	return { config };
}

function setupOutputSpies(): OutputSpies {
	return {
		consoleError: vi.spyOn(console, "error").mockImplementation(() => {}),
		consoleLog: vi.spyOn(console, "log").mockImplementation(() => {}),
		stderr: vi.spyOn(process.stderr, "write").mockReturnValue(true),
		stdout: vi.spyOn(process.stdout, "write").mockReturnValue(true),
	};
}

describe(parseArgs, () => {
	it("should return help when --help is passed", () => {
		expect.assertions(1);

		const result = parseArgs(["--help"]);

		expect(result.help).toBeTrue();
	});

	it("should return version when --version is passed", () => {
		expect.assertions(1);

		const result = parseArgs(["--version"]);

		expect(result.version).toBeTrue();
	});

	it("should parse --config option", () => {
		expect.assertions(1);

		const result = parseArgs(["--config", "./custom.config.ts"]);

		expect(result.config).toBe("./custom.config.ts");
	});

	it("should parse --testPathPattern option", () => {
		expect.assertions(1);

		const result = parseArgs(["--testPathPattern", "player"]);

		expect(result.testPathPattern).toBe("player");
	});

	it("should parse -t / --testNamePattern option", () => {
		expect.assertions(2);

		const result = parseArgs(["-t", "should spawn"]);

		expect(result.testNamePattern).toBe("should spawn");

		const longResult = parseArgs(["--testNamePattern", "should spawn"]);

		expect(longResult.testNamePattern).toBe("should spawn");
	});

	it("should parse --formatters json", () => {
		expect.assertions(1);

		const result = parseArgs(["--formatters", "json"]);

		expect(result.formatters).toStrictEqual(["json"]);
	});

	it("should parse --outputFile option", () => {
		expect.assertions(1);

		const result = parseArgs(["--outputFile", "results.json"]);

		expect(result.outputFile).toBe("results.json");
	});

	it("should parse --verbose flag", () => {
		expect.assertions(1);

		const result = parseArgs(["--verbose"]);

		expect(result.verbose).toBeTrue();
	});

	it("should parse --silent flag", () => {
		expect.assertions(1);

		const result = parseArgs(["--silent"]);

		expect(result.silent).toBeTrue();
	});

	it("should parse positional file arguments", () => {
		expect.assertions(1);

		const result = parseArgs(["src/test.spec.ts", "src/other.spec.ts"]);

		expect(result.files).toStrictEqual(["src/test.spec.ts", "src/other.spec.ts"]);
	});

	it("should parse combined options and files", () => {
		expect.assertions(3);

		const result = parseArgs(["--verbose", "-t", "should pass", "src/test.spec.ts"]);

		expect(result.verbose).toBeTrue();
		expect(result.testNamePattern).toBe("should pass");
		expect(result.files).toStrictEqual(["src/test.spec.ts"]);
	});

	it("should parse --formatters agent", () => {
		expect.assertions(1);

		const result = parseArgs(["--formatters", "agent"]);

		expect(result.formatters).toStrictEqual(["agent"]);
	});

	it("should parse --no-cache flag", () => {
		expect.assertions(1);

		const result = parseArgs(["--no-cache"]);

		expect(result.cache).toBeFalse();
	});

	it("should parse --no-color flag", () => {
		expect.assertions(1);

		const result = parseArgs(["--no-color"]);

		expect(result.color).toBeFalse();
	});

	it("should parse --gameOutput option", () => {
		expect.assertions(1);

		const result = parseArgs(["--gameOutput", "/tmp/game-output.json"]);

		expect(result.gameOutput).toBe("/tmp/game-output.json");
	});

	it("should parse --no-show-luau flag", () => {
		expect.assertions(1);

		const result = parseArgs(["--no-show-luau"]);

		expect(result.showLuau).toBeFalse();
	});

	it("should parse -u / --updateSnapshot flag", () => {
		expect.assertions(2);

		const result = parseArgs(["-u"]);

		expect(result.updateSnapshot).toBeTrue();

		const longResult = parseArgs(["--updateSnapshot"]);

		expect(longResult.updateSnapshot).toBeTrue();
	});

	it("should parse --typecheck flag", () => {
		expect.assertions(1);

		const result = parseArgs(["--typecheck"]);

		expect(result.typecheck).toBeTrue();
	});

	it("should parse --typecheckOnly flag and imply --typecheck", () => {
		expect.assertions(2);

		const result = parseArgs(["--typecheckOnly"]);

		expect(result.typecheckOnly).toBeTrue();
		expect(result.typecheck).toBeTrue();
	});

	it("should parse --typecheckTsconfig option", () => {
		expect.assertions(1);

		const result = parseArgs(["--typecheckTsconfig", "tsconfig.test.json"]);

		expect(result.typecheckTsconfig).toBe("tsconfig.test.json");
	});

	it("should parse valid --backend values", () => {
		expect.assertions(3);

		expect(parseArgs(["--backend", "auto"]).backend).toBe("auto");
		expect(parseArgs(["--backend", "open-cloud"]).backend).toBe("open-cloud");
		expect(parseArgs(["--backend", "studio"]).backend).toBe("studio");
	});

	it("should throw on invalid --backend value", () => {
		expect.assertions(2);

		expect(() => parseArgs(["--backend", "not-a-backend"])).toThrow(
			'Invalid backend "not-a-backend"',
		);
		expect(() => parseArgs(["--backend", "invalid"])).toThrow(
			"Must be one of: auto, open-cloud, studio",
		);
	});

	it("should parse --coverage flag", () => {
		expect.assertions(1);

		const result = parseArgs(["--coverage"]);

		expect(result.collectCoverage).toBeTrue();
	});

	it("should parse --coverageDirectory option", () => {
		expect.assertions(1);

		const result = parseArgs(["--coverageDirectory", "my-coverage"]);

		expect(result.coverageDirectory).toBe("my-coverage");
	});

	it("should parse --coverageReporters with multiple values", () => {
		expect.assertions(1);

		const result = parseArgs([
			"--coverageReporters",
			"text",
			"--coverageReporters",
			"lcov",
			"--coverageReporters",
			"html",
		]);

		expect(result.coverageReporters).toStrictEqual(["text", "lcov", "html"]);
	});

	it("should parse --collectCoverageFrom with multiple values", () => {
		expect.assertions(1);

		const result = parseArgs([
			"--collectCoverageFrom",
			"src/**/*.ts",
			"--collectCoverageFrom",
			"lib/**/*.ts",
		]);

		expect(result.collectCoverageFrom).toStrictEqual(["src/**/*.ts", "lib/**/*.ts"]);
	});

	it("should leave collectCoverageFrom undefined when not passed", () => {
		expect.assertions(1);

		const result = parseArgs([]);

		expect(result.collectCoverageFrom).toBeUndefined();
	});

	it("should parse --pollInterval option", () => {
		expect.assertions(1);

		const result = parseArgs(["--pollInterval", "1000"]);

		expect(result.pollInterval).toBe(1000);
	});

	it("should parse --port option", () => {
		expect.assertions(1);

		const result = parseArgs(["--port", "4000"]);

		expect(result.port).toBe(4000);
	});

	it("should parse --timeout option", () => {
		expect.assertions(1);

		const result = parseArgs(["--timeout", "60000"]);

		expect(result.timeout).toBe(60000);
	});

	it("should parse single --project flag", () => {
		expect.assertions(1);

		const result = parseArgs(["--project", "client"]);

		expect(result.project).toStrictEqual(["client"]);
	});

	it("should parse multiple --project flags", () => {
		expect.assertions(1);

		const result = parseArgs(["--project", "client", "--project", "server"]);

		expect(result.project).toStrictEqual(["client", "server"]);
	});

	it("should parse --passWithNoTests flag", () => {
		expect.assertions(1);

		const result = parseArgs(["--passWithNoTests"]);

		expect(result.passWithNoTests).toBeTrue();
	});

	it("should parse --parallel with integer value", () => {
		expect.assertions(1);

		const result = parseArgs(["--parallel", "3"]);

		expect(result.parallel).toBe(3);
	});

	it('should parse --parallel with "auto"', () => {
		expect.assertions(1);

		const result = parseArgs(["--parallel", "auto"]);

		expect(result.parallel).toBe("auto");
	});

	it('should treat bare --parallel (no value) as "auto"', () => {
		expect.assertions(1);

		const result = parseArgs(["--parallel"]);

		expect(result.parallel).toBe("auto");
	});

	it("should treat --parallel followed by another flag as auto", () => {
		expect.assertions(2);

		const result = parseArgs(["--parallel", "--verbose"]);

		expect(result.parallel).toBe("auto");
		expect(result.verbose).toBeTrue();
	});

	it("should leave parallel undefined when flag not present", () => {
		expect.assertions(1);

		const result = parseArgs([]);

		expect(result.parallel).toBeUndefined();
	});

	it("should throw on --parallel 0", () => {
		expect.assertions(1);

		expect(() => parseArgs(["--parallel", "0"])).toThrow("Invalid --parallel value");
	});

	it("should throw on --parallel -1", () => {
		expect.assertions(1);

		// Pre-normalized to "--parallel -1" still reads as a string value since
		// "-1" starts with "-", so normalization rewrites it to "auto"; force
		// the value form explicitly via "=" syntax.
		expect(() => parseArgs(["--parallel=-1"])).toThrow("Invalid --parallel value");
	});

	it("should throw on --parallel non-numeric", () => {
		expect.assertions(1);

		expect(() => parseArgs(["--parallel=xyz"])).toThrow("Invalid --parallel value");
	});
});

describe(run, () => {
	it("should return 2 and print banner for ConfigError", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.loadConfig.mockRejectedValue(new ConfigError("bad value", "try this instead"));

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("bad value"));
	});

	it("should return 2 and print banner for ConfigError without hint", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.loadConfig.mockRejectedValue(new ConfigError("missing field"));

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("missing field"));
	});

	it("should return 2 and print hint for LuauScriptError", async () => {
		expect.assertions(3);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.loadConfig.mockRejectedValue(
			new LuauScriptError("Failed to find Jest instance in ReplicatedStorage"),
		);

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("Luau Error"));
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("Hint:"));
	});

	it("should print game output context for LuauScriptError with gameOutput", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults();

		const gameEntries = [
			{ message: "No tests found, exiting with code 1", messageType: 0, timestamp: 0 },
		];
		mocks.parseGameOutput.mockReturnValue(gameEntries);

		const error = new LuauScriptError("Exited with code: 1");
		error.gameOutput = "raw-game-output";
		mocks.loadConfig.mockRejectedValue(error);

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.stderr).toHaveBeenCalledWith(
			expect.stringContaining("No tests found, exiting with code 1"),
		);
	});

	it("should omit game output section when gameOutput has no parsed entries", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults();

		const error = new LuauScriptError("Exited with code: 1");
		error.gameOutput = "raw-game-output";
		mocks.loadConfig.mockRejectedValue(error);

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("Game output:"));
	});

	it("should return 2 and print message for generic Error", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.loadConfig.mockRejectedValue(new Error("something broke"));

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.consoleError).toHaveBeenCalledWith("Error: something broke");
	});

	it("should return 2 for unknown error", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.loadConfig.mockRejectedValue("string-error");

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.consoleError).toHaveBeenCalledWith("An unknown error occurred");
	});
});

describe("runInner via run", () => {
	it("should print help and return 0", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		const code = await run(["--help"]);

		expect(code).toBe(0);
		expect(spies.consoleLog).toHaveBeenCalledWith(
			expect.stringContaining("Usage: jest-roblox"),
		);
	});

	it("should print version and return 0", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		const { default: package_ } = await import("../package.json");
		const code = await run(["--version"]);

		expect(code).toBe(0);
		expect(spies.consoleLog).toHaveBeenCalledWith(package_.version);
	});

	it("should return 2 when no test files found", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.globSync.mockReturnValue([]);

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.consoleError).toHaveBeenCalledWith("No test files found");
	});

	it("should return 0 when no test files found and passWithNoTests is set", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults({ passWithNoTests: true });
		mocks.globSync.mockReturnValue([]);

		const code = await run([]);

		expect(code).toBe(0);
		expect(spies.consoleError).not.toHaveBeenCalled();
	});

	it("should return 0 via --passWithNoTests CLI flag when no test files found", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults();
		mocks.globSync.mockReturnValue([]);

		const code = await run(["--passWithNoTests"]);

		expect(code).toBe(0);
	});

	it("should return 2 when no files match selected mode", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults({ typecheck: true, typecheckOnly: true });
		mocks.globSync.mockReturnValue(["/test/foo.spec.ts"]);

		const code = await run(["--typecheckOnly"]);

		expect(code).toBe(2);
		expect(spies.consoleError).toHaveBeenCalledWith(
			"No test files found for the selected mode",
		);
	});

	it("should return 0 when no files match selected mode and passWithNoTests is set", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults({ passWithNoTests: true, typecheck: true, typecheckOnly: true });
		mocks.globSync.mockReturnValue(["/test/foo.spec.ts"]);

		const code = await run(["--typecheckOnly"]);

		expect(code).toBe(0);
		expect(spies.consoleError).not.toHaveBeenCalled();
	});

	it("should run runtime tests and return 0 on success", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults();

		const code = await run([]);

		expect(code).toBe(0);
	});

	it("should reject --typecheck in SEA binary", async () => {
		expect.assertions(2);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const code = await run(["--typecheck"]);

		expect(code).toBe(2);
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("standalone binary"));
	});

	it("should reject --typecheckOnly in SEA binary", async () => {
		expect.assertions(2);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const code = await run(["--typecheckOnly"]);

		expect(code).toBe(2);
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("standalone binary"));
	});

	it("should run typecheck tests and return results", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults({ typecheck: true });
		mocks.globSync.mockReturnValue(["/test/foo.spec-d.ts"]);
		mocks.runTypecheck.mockReturnValue(makeJestResult());

		const code = await run(["--typecheck"]);

		expect(code).toBe(0);
		expect(mocks.runTypecheck).toHaveBeenCalledWith(
			expect.objectContaining({ files: ["/test/foo.spec-d.ts"] }),
		);
	});

	it("should run both typecheck and runtime tests", async () => {
		expect.assertions(3);

		setupOutputSpies();
		setupDefaults({ typecheck: true });
		mocks.globSync.mockReturnValue(["/test/foo.spec.ts", "/test/bar.spec-d.ts"]);
		mocks.runTypecheck.mockReturnValue(makeJestResult());
		mocks.execute.mockResolvedValue(makeExecuteResult());

		const code = await run(["--typecheck"]);

		expect(code).toBe(0);
		expect(mocks.runTypecheck).toHaveBeenCalledWith(
			expect.objectContaining({ files: ["/test/bar.spec-d.ts"] }),
		);
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.objectContaining({ testFiles: ["/test/foo.spec.ts"] }),
		);
	});

	it("should preserve numTodoTests when merging typecheck and runtime", async () => {
		expect.assertions(1);

		setupOutputSpies();
		vol.mkdirSync("/tmp", { recursive: true });
		vol.writeFileSync("/tmp/summary.md", "");
		onTestFinished(() => {
			vol.reset();
		});

		setupDefaults({
			formatters: [["github-actions", { jobSummary: { outputPath: "/tmp/summary.md" } }]],
			typecheck: true,
		});
		mocks.globSync.mockReturnValue(["/test/foo.spec.ts", "/test/bar.spec-d.ts"]);
		mocks.runTypecheck.mockReturnValue(makeJestResult({ numTodoTests: 1 }));
		mocks.execute.mockResolvedValue(
			makeExecuteResult({ result: makeJestResult({ numTodoTests: 2 }) }),
		);

		await run(["--typecheck"]);

		const content = vol.readFileSync("/tmp/summary.md", "utf-8") as string;

		expect(content).toContain("3 todos");
	});

	it("should prepare coverage when collectCoverage enabled", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults({ collectCoverage: true });
		mocks.prepareCoverage.mockReturnValue({
			manifest: { files: [] } as never,
			placeFile: "/test/coverage.rbxl",
		});

		const code = await run(["--coverage"]);

		expect(code).toBe(0);
		expect(mocks.prepareCoverage).toHaveBeenCalledWith(
			expect.objectContaining({ collectCoverage: true }),
		);
	});

	it("should print file count when not all files selected", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.globSync.mockReturnValue(["/test/a.spec.ts", "/test/b.spec.ts"]);
		mocks.execute.mockResolvedValue(makeExecuteResult());

		const code = await run(["--testPathPattern", "a\\.spec"]);

		expect(code).toBe(0);
		expect(spies.stderr).toHaveBeenCalledWith("Running 1 of 2 test files\n");
	});

	it("should write outputFile when configured", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults({ outputFile: "/test/results.json" });
		mocks.writeJsonFile.mockResolvedValue();

		const code = await run(["--outputFile", "/test/results.json"]);

		expect(code).toBe(0);
		expect(mocks.writeJsonFile).toHaveBeenCalledWith(
			expect.objectContaining({ success: true }),
			"/test/results.json",
		);
	});

	it("should write game output when configured", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults({ gameOutput: "/test/game.json" });
		mocks.execute.mockResolvedValue(makeExecuteResult({ gameOutput: "[]" }));
		mocks.parseGameOutput.mockReturnValue([]);
		mocks.formatGameOutputNotice.mockReturnValue("");

		const code = await run(["--gameOutput", "/test/game.json"]);

		expect(code).toBe(0);
		expect(mocks.writeGameOutput).toHaveBeenCalledWith("/test/game.json", []);
	});

	it("should process coverage and print header", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults({ collectCoverage: true });
		const coverageData = { "file.luau": { s: { "0": 1 } } } as never;
		const manifest = { files: [] } as never;
		const mapped = { files: {} };

		mocks.prepareCoverage.mockReturnValue({ manifest, placeFile: "/test/cov.rbxl" });
		mocks.execute.mockResolvedValue(makeExecuteResult({ coverageData }));
		mocks.loadCoverageManifest.mockReturnValue(manifest);
		mocks.mapCoverageToTypeScript.mockReturnValue(mapped);
		mocks.checkThresholds.mockReturnValue({ failures: [], passed: true });

		const code = await run(["--coverage"]);

		expect(code).toBe(0);
		expect(mocks.generateReports).toHaveBeenCalledWith(expect.objectContaining({ mapped }));
	});

	it("should pass collectCoverageFrom from CLI to generateReports", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults({ collectCoverage: true });
		const coverageData = { "file.luau": { s: { "0": 1 } } } as never;
		const manifest = { files: [] } as never;
		const mapped = { files: {} };

		mocks.prepareCoverage.mockReturnValue({ manifest, placeFile: "/test/cov.rbxl" });
		mocks.execute.mockResolvedValue(makeExecuteResult({ coverageData }));
		mocks.loadCoverageManifest.mockReturnValue(manifest);
		mocks.mapCoverageToTypeScript.mockReturnValue(mapped);
		mocks.checkThresholds.mockReturnValue({ failures: [], passed: true });

		await run(["--coverage", "--collectCoverageFrom", "src/**/*.ts"]);

		expect(mocks.generateReports).toHaveBeenCalledWith(
			expect.objectContaining({ collectCoverageFrom: ["src/**/*.ts"] }),
		);
	});

	it("should pass collectCoverageFrom from config to generateReports", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults({
			collectCoverage: true,
			collectCoverageFrom: ["lib/**/*.ts"],
		});
		const coverageData = { "file.luau": { s: { "0": 1 } } } as never;
		const manifest = { files: [] } as never;
		const mapped = { files: {} };

		mocks.prepareCoverage.mockReturnValue({ manifest, placeFile: "/test/cov.rbxl" });
		mocks.execute.mockResolvedValue(makeExecuteResult({ coverageData }));
		mocks.loadCoverageManifest.mockReturnValue(manifest);
		mocks.mapCoverageToTypeScript.mockReturnValue(mapped);
		mocks.checkThresholds.mockReturnValue({ failures: [], passed: true });

		await run(["--coverage"]);

		expect(mocks.generateReports).toHaveBeenCalledWith(
			expect.objectContaining({ collectCoverageFrom: ["lib/**/*.ts"] }),
		);
	});

	it("should override config collectCoverageFrom with CLI value", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults({
			collectCoverage: true,
			collectCoverageFrom: ["lib/**/*.ts"],
		});
		const coverageData = { "file.luau": { s: { "0": 1 } } } as never;
		const manifest = { files: [] } as never;
		const mapped = { files: {} };

		mocks.prepareCoverage.mockReturnValue({ manifest, placeFile: "/test/cov.rbxl" });
		mocks.execute.mockResolvedValue(makeExecuteResult({ coverageData }));
		mocks.loadCoverageManifest.mockReturnValue(manifest);
		mocks.mapCoverageToTypeScript.mockReturnValue(mapped);
		mocks.checkThresholds.mockReturnValue({ failures: [], passed: true });

		await run(["--coverage", "--collectCoverageFrom", "src/**/*.ts"]);

		expect(mocks.generateReports).toHaveBeenCalledWith(
			expect.objectContaining({ collectCoverageFrom: ["src/**/*.ts"] }),
		);
	});

	it("should return 1 when coverage threshold not met", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults({
			collectCoverage: true,
			coverageThreshold: { lines: 90 },
		});
		const coverageData = { "file.luau": { s: { "0": 1 } } } as never;
		const manifest = { files: [] } as never;
		const mapped = { files: {} };

		mocks.prepareCoverage.mockReturnValue({ manifest, placeFile: "/test/cov.rbxl" });
		mocks.execute.mockResolvedValue(makeExecuteResult({ coverageData }));
		mocks.loadCoverageManifest.mockReturnValue(manifest);
		mocks.mapCoverageToTypeScript.mockReturnValue(mapped);
		mocks.checkThresholds.mockReturnValue({
			failures: [{ actual: 50, metric: "lines", threshold: 90 }],
			passed: false,
		});

		const code = await run(["--coverage"]);

		expect(code).toBe(1);
	});

	it("should warn when coverage manifest missing", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults({ collectCoverage: true });
		const coverageData = { "file.luau": { s: { "0": 1 } } } as never;

		mocks.prepareCoverage.mockReturnValue({
			manifest: {} as never,
			placeFile: "/test/cov.rbxl",
		});
		mocks.execute.mockResolvedValue(makeExecuteResult({ coverageData }));
		mocks.loadCoverageManifest.mockReturnValue(undefined);

		const code = await run(["--coverage"]);

		expect(code).toBe(0);
		expect(spies.stderr).toHaveBeenCalledWith(
			"Warning: Coverage manifest not found, skipping TS mapping\n",
		);
	});

	it("should warn when coverage enabled but runtime returned no data", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults({ collectCoverage: true });

		mocks.prepareCoverage.mockReturnValue({
			manifest: {} as never,
			placeFile: "/test/cov.rbxl",
		});
		mocks.execute.mockResolvedValue(makeExecuteResult({ coverageData: undefined }));

		const code = await run(["--coverage"]);

		expect(code).toBe(0);
		expect(spies.stderr).toHaveBeenCalledWith(
			expect.stringContaining("coverage data was empty"),
		);
	});

	it("should suppress empty coverage data warning when silent", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults({ collectCoverage: true, silent: true });

		mocks.prepareCoverage.mockReturnValue({
			manifest: {} as never,
			placeFile: "/test/cov.rbxl",
		});
		mocks.execute.mockResolvedValue(makeExecuteResult({ coverageData: undefined }));

		const code = await run(["--silent", "--coverage"]);

		expect(code).toBe(0);
		expect(spies.stderr).not.toHaveBeenCalledWith(
			expect.stringContaining("coverage data was empty"),
		);
	});

	it("should print PASS badge when coverage enabled and passing", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults({ collectCoverage: true });
		mocks.prepareCoverage.mockReturnValue({
			manifest: {} as never,
			placeFile: "/test/cov.rbxl",
		});
		mocks.execute.mockResolvedValue(makeExecuteResult());
		mocks.loadCoverageManifest.mockReturnValue(undefined);

		const code = await run(["--coverage"]);

		expect(code).toBe(0);
		expect(spies.stdout).toHaveBeenCalledWith(expect.stringContaining("PASS"));
	});

	it("should print FAIL badge when coverage enabled and failing", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults({
			collectCoverage: true,
			coverageThreshold: { lines: 90 },
		});
		const coverageData = { "file.luau": { s: { "0": 1 } } } as never;
		const manifest = { files: [] } as never;
		const mapped = { files: {} };

		mocks.prepareCoverage.mockReturnValue({ manifest, placeFile: "/test/cov.rbxl" });
		mocks.execute.mockResolvedValue(makeExecuteResult({ coverageData }));
		mocks.loadCoverageManifest.mockReturnValue(manifest);
		mocks.mapCoverageToTypeScript.mockReturnValue(mapped);
		mocks.checkThresholds.mockReturnValue({
			failures: [{ actual: 50, metric: "lines", threshold: 90 }],
			passed: false,
		});

		const code = await run(["--coverage"]);

		expect(code).toBe(1);
		expect(spies.stdout).toHaveBeenCalledWith(expect.stringContaining("FAIL"));
	});

	it("should resolve CLI file paths relative to rootDir", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults();
		mocks.execute.mockResolvedValue(makeExecuteResult());

		const code = await run(["src/foo.spec.ts"]);

		expect(code).toBe(0);
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				testFiles: [expect.stringContaining(["test", "src", "foo.spec.ts"].join(path.sep))],
			}),
		);
	});

	it("should filter by testPathPattern", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults();
		mocks.globSync.mockReturnValue(["/test/a.spec.ts", "/test/b.spec.ts"]);
		mocks.execute.mockResolvedValue(makeExecuteResult());

		const code = await run(["--testPathPattern", "a\\.spec"]);

		expect(code).toBe(0);
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				testFiles: ["/test/a.spec.ts"],
			}),
		);
	});

	it("should filter by testPathIgnorePatterns", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults({
			testPathIgnorePatterns: ["ignored"],
		});
		mocks.globSync.mockReturnValue(["/test/a.spec.ts", "/test/ignored/b.spec.ts"]);
		mocks.execute.mockResolvedValue(makeExecuteResult());

		const code = await run([]);

		expect(code).toBe(0);
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				testFiles: ["/test/a.spec.ts"],
			}),
		);
	});

	it("should skip game output notice when silent", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults({ gameOutput: "/test/game.json", silent: true });
		mocks.execute.mockResolvedValue(makeExecuteResult({ gameOutput: "[]" }));
		mocks.parseGameOutput.mockReturnValue([]);

		const code = await run(["--silent", "--gameOutput", "/test/game.json"]);

		expect(code).toBe(0);
		expect(mocks.formatGameOutputNotice).not.toHaveBeenCalled();
	});

	it("should skip game output when not configured", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults();
		mocks.execute.mockResolvedValue(makeExecuteResult());

		const code = await run([]);

		expect(code).toBe(0);
		expect(mocks.writeGameOutput).not.toHaveBeenCalled();
	});

	it("should print typecheck failure details", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		const failResult = makeJestResult({
			numFailedTests: 1,
			success: false,
			testResults: [
				{
					failureMessage: undefined,
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "/test/foo.spec-d.ts",
					testResults: [
						{
							ancestorTitles: [],
							duration: 0,
							failureMessages: ["Expected type string, got number"],
							fullName: "should accept string",
							status: "failed",
							title: "should accept string",
						},
					],
				},
			],
		});

		setupDefaults({ typecheck: true });
		mocks.globSync.mockReturnValue(["/test/foo.spec-d.ts"]);
		mocks.runTypecheck.mockReturnValue(failResult);

		const code = await run(["--typecheck"]);

		expect(code).toBe(1);
		expect(spies.stdout).toHaveBeenCalledWith(expect.stringContaining("should accept string"));
	});

	it("should print typecheck summary without failures", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults({ typecheck: true });
		mocks.globSync.mockReturnValue(["/test/foo.spec-d.ts"]);
		mocks.runTypecheck.mockReturnValue(makeJestResult({ numPassedTests: 3, numTotalTests: 3 }));

		const code = await run(["--typecheck"]);

		expect(code).toBe(0);
		expect(spies.stdout).toHaveBeenCalledWith(expect.stringContaining("Type Tests:"));
	});

	it("should return 1 when runtime tests fail", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults();
		mocks.execute.mockResolvedValue(
			makeExecuteResult({
				result: makeJestResult({ numFailedTests: 1, success: false }),
			}),
		);

		const code = await run([]);

		expect(code).toBe(1);
	});

	it("should override config values with CLI values", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults({ verbose: false });
		mocks.execute.mockResolvedValue(makeExecuteResult());

		const code = await run(["--verbose"]);

		expect(code).toBe(0);
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				config: expect.objectContaining({ verbose: true }) as unknown,
			}),
		);
	});

	it("should keep config values when CLI is undefined", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults({ verbose: true });
		mocks.execute.mockResolvedValue(makeExecuteResult());

		const code = await run([]);

		expect(code).toBe(0);
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				config: expect.objectContaining({ verbose: true }) as unknown,
			}),
		);
	});

	it("should show game output notice when not silent and entries exist", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults({ gameOutput: "/test/game.json" });
		mocks.execute.mockResolvedValue(
			makeExecuteResult({ gameOutput: '[{"type":"print","message":"hi"}]' }),
		);
		mocks.parseGameOutput.mockReturnValue([{ message: "hi", type: "print" }] as never);
		mocks.formatGameOutputNotice.mockReturnValue(
			"Game output (1 entries) written to /test/game.json",
		);

		const code = await run(["--gameOutput", "/test/game.json"]);

		expect(code).toBe(0);
		expect(spies.consoleError).toHaveBeenCalledWith(
			"Game output (1 entries) written to /test/game.json",
		);
	});

	it("should return 2 and print LuauScriptError without hint for unknown message", async () => {
		expect.assertions(3);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.loadConfig.mockRejectedValue(new LuauScriptError("some unknown luau error"));

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("Luau Error"));
		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("Hint:"));
	});

	it("should print typecheck failures skipping non-failed tests", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		const typecheckResult = makeJestResult({
			numFailedTests: 1,
			numPassedTests: 1,
			numTotalTests: 2,
			success: false,
			testResults: [
				{
					failureMessage: undefined,
					numFailingTests: 1,
					numPassingTests: 1,
					numPendingTests: 0,
					testFilePath: "/test/mixed.spec-d.ts",
					testResults: [
						{
							ancestorTitles: [],
							duration: 0,
							failureMessages: [],
							fullName: "should pass type",
							status: "passed",
							title: "should pass type",
						},
						{
							ancestorTitles: [],
							duration: 0,
							failureMessages: ["Type mismatch"],
							fullName: "should fail type",
							status: "failed",
							title: "should fail type",
						},
					],
				},
			],
		});

		setupDefaults({ typecheck: true });
		mocks.globSync.mockReturnValue(["/test/mixed.spec-d.ts"]);
		mocks.runTypecheck.mockReturnValue(typecheckResult);

		const code = await run(["--typecheck"]);

		expect(code).toBe(1);
		expect(spies.stderr).not.toHaveBeenCalledWith(
			expect.stringContaining("FAIL should pass type"),
		);
	});

	it("should print runtime output when present", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.formatExecuteOutput.mockReturnValue("Test output here");

		const code = await run([]);

		expect(code).toBe(0);
		expect(spies.consoleLog).toHaveBeenCalledWith("Test output here");
	});

	it("should use formatExecuteOutput for --formatters json with --typecheck", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults({ formatters: ["json"], typecheck: true });
		mocks.globSync.mockReturnValue(["/test/foo.spec.ts", "/test/bar.spec-d.ts"]);
		mocks.runTypecheck.mockReturnValue(makeJestResult());
		mocks.formatExecuteOutput.mockReturnValue('{"json":"output"}');

		const code = await run(["--formatters", "json", "--typecheck"]);

		expect(code).toBe(0);
		expect(spies.consoleLog).toHaveBeenCalledWith('{"json":"output"}');
	});

	it("should use formatExecuteOutput for --formatters agent with --typecheck", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults({ formatters: ["agent"], typecheck: true });
		mocks.globSync.mockReturnValue(["/test/foo.spec.ts", "/test/bar.spec-d.ts"]);
		mocks.runTypecheck.mockReturnValue(makeJestResult());
		mocks.formatExecuteOutput.mockReturnValue("agent output");

		const code = await run(["--formatters", "agent", "--typecheck"]);

		expect(code).toBe(0);
		expect(spies.consoleLog).toHaveBeenCalledWith("agent output");
	});

	it("should skip empty formatExecuteOutput for --formatters json with --typecheck", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults({ formatters: ["json"], typecheck: true });
		mocks.globSync.mockReturnValue(["/test/foo.spec.ts", "/test/bar.spec-d.ts"]);
		mocks.runTypecheck.mockReturnValue(makeJestResult());
		mocks.formatExecuteOutput.mockReturnValue("");

		const code = await run(["--formatters", "json", "--typecheck"]);

		expect(code).toBe(0);
		expect(spies.consoleLog).not.toHaveBeenCalled();
	});

	it("should show file count when using default formatter with filtered files", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults({ verbose: true });
		mocks.globSync.mockReturnValue(["/test/a.spec.ts", "/test/b.spec.ts"]);
		mocks.execute.mockResolvedValue(makeExecuteResult());

		const code = await run(["--verbose", "--testPathPattern", "a\\.spec"]);

		expect(code).toBe(0);
		expect(spies.stderr).toHaveBeenCalledWith("Running 1 of 2 test files\n");
	});

	it("should suppress coverage warning when silent", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults({ collectCoverage: true, silent: true });
		const coverageData = { "file.luau": { s: { "0": 1 } } } as never;

		mocks.prepareCoverage.mockReturnValue({
			manifest: {} as never,
			placeFile: "/test/cov.rbxl",
		});
		mocks.execute.mockResolvedValue(makeExecuteResult({ coverageData }));
		mocks.loadCoverageManifest.mockReturnValue(undefined);

		const code = await run(["--silent", "--coverage"]);

		expect(code).toBe(0);
		expect(spies.stderr).not.toHaveBeenCalledWith(
			"Warning: Coverage manifest not found, skipping TS mapping\n",
		);
	});

	it("should skip coverage header when silent", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults({ collectCoverage: true, silent: true });
		const coverageData = { "file.luau": { s: { "0": 1 } } } as never;
		const manifest = { files: [] } as never;
		const mapped = { files: {} };

		mocks.prepareCoverage.mockReturnValue({ manifest, placeFile: "/test/cov.rbxl" });
		mocks.execute.mockResolvedValue(makeExecuteResult({ coverageData }));
		mocks.loadCoverageManifest.mockReturnValue(manifest);
		mocks.mapCoverageToTypeScript.mockReturnValue(mapped);

		const code = await run(["--silent", "--coverage"]);

		expect(code).toBe(0);
		expect(spies.stdout).not.toHaveBeenCalledWith(expect.stringContaining("Coverage"));
	});

	it("should return 0 when coverage threshold met", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults({
			collectCoverage: true,
			coverageThreshold: { lines: 80 },
		});
		const coverageData = { "file.luau": { s: { "0": 1 } } } as never;
		const manifest = { files: [] } as never;
		const mapped = { files: {} };

		mocks.prepareCoverage.mockReturnValue({ manifest, placeFile: "/test/cov.rbxl" });
		mocks.execute.mockResolvedValue(makeExecuteResult({ coverageData }));
		mocks.loadCoverageManifest.mockReturnValue(manifest);
		mocks.mapCoverageToTypeScript.mockReturnValue(mapped);
		mocks.checkThresholds.mockReturnValue({ failures: [], passed: true });

		const code = await run(["--coverage"]);

		expect(code).toBe(0);
	});

	it("should resolve setupFiles paths before execution", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults({
			rojoProject: "default.project.json",
			setupFiles: ["./src/test-setup.ts"],
			setupFilesAfterEnv: ["@rbxts/test-utils/setup"],
		});
		const mockResolver = vi
			.fn<(input: string) => string>()
			.mockReturnValueOnce("ReplicatedStorage/client/test-setup")
			.mockReturnValueOnce("ReplicatedStorage/rbxts_include/node_modules/test-utils/setup");
		mocks.createSetupResolver.mockReturnValue(mockResolver);

		vol.mkdirSync("/test", { recursive: true });
		vol.writeFileSync(
			"/test/default.project.json",
			JSON.stringify({ name: "test", tree: { $className: "DataModel" } }),
		);
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run([]);

		expect(code).toBe(0);
		expect(mockResolver).toHaveBeenCalledTimes(2);
	});

	it("should resolve only setupFiles when setupFilesAfterEnv is absent", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults({
			setupFiles: ["./src/test-setup.ts"],
		});
		const mockResolver = vi
			.fn<(input: string) => string>()
			.mockReturnValue("ReplicatedStorage/client/test-setup");
		mocks.createSetupResolver.mockReturnValue(mockResolver);

		vol.mkdirSync("/test", { recursive: true });
		vol.writeFileSync(
			"/test/default.project.json",
			JSON.stringify({ name: "test", tree: { $className: "DataModel" } }),
		);
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run([]);

		expect(code).toBe(0);
		expect(mockResolver).toHaveBeenCalledOnce();
	});

	it("should resolve only setupFilesAfterEnv when setupFiles is absent", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults({
			rojoProject: "default.project.json",
			setupFilesAfterEnv: ["@rbxts/test-utils/setup"],
		});
		const mockResolver = vi
			.fn<(input: string) => string>()
			.mockReturnValue("ReplicatedStorage/rbxts_include/node_modules/test-utils/setup");
		mocks.createSetupResolver.mockReturnValue(mockResolver);

		vol.mkdirSync("/test", { recursive: true });
		vol.writeFileSync(
			"/test/default.project.json",
			JSON.stringify({ name: "test", tree: { $className: "DataModel" } }),
		);
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run([]);

		expect(code).toBe(0);
		expect(mockResolver).toHaveBeenCalledOnce();
	});

	it("should skip setup file resolution when none configured", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults();

		const code = await run([]);

		expect(code).toBe(0);
		expect(mocks.createSetupResolver).not.toHaveBeenCalled();
	});
});

describe(main, () => {
	it("should call process.exit with the run result", async () => {
		expect.assertions(1);

		setupDefaults();
		mocks.globSync.mockReturnValue(["/test/foo.spec.ts"]);
		mocks.execute.mockResolvedValue(makeExecuteResult());

		const exitSpy = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
		setupOutputSpies();

		// Override process.argv so parseArgs gets known args
		const originalArgv = process.argv;
		process.argv = ["node", "jest-roblox"];

		try {
			await main();
		} finally {
			process.argv = originalArgv;
		}

		expect(exitSpy).toHaveBeenCalledWith(0);
	});
});

describe("parseArgs formatters", () => {
	it("should parse --formatters option", () => {
		expect.assertions(1);

		const result = parseArgs(["--formatters", "default", "--formatters", "github-actions"]);

		expect(result.formatters).toStrictEqual(["default", "github-actions"]);
	});
});

describe("resolveFormatters", () => {
	it("should auto-add github-actions when GITHUB_ACTIONS=true and not explicitly set", async () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		setupDefaults();
		const failResult = makeJestResult({
			numFailedTests: 1,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "src/test.spec.ts",
					testResults: [
						{
							ancestorTitles: [],
							duration: 5,
							failureMessages: ["Expected 1 to be 2"],
							fullName: "should work",
							status: "failed",
							title: "should work",
						},
					],
				},
			],
		});
		mocks.execute.mockResolvedValue(makeExecuteResult({ result: failResult }));

		vi.stubEnv("GITHUB_ACTIONS", "true");

		await run([]);

		const stderrOutput = spies.stderr.mock.calls.map(([argument]) => String(argument)).join("");

		expect(stderrOutput).toContain("::error");
	});

	it("should not auto-add github-actions when formatters explicitly set in config", async () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		setupDefaults({ formatters: ["default"] });
		const failResult = makeJestResult({
			numFailedTests: 1,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "src/test.spec.ts",
					testResults: [
						{
							ancestorTitles: [],
							duration: 5,
							failureMessages: ["Expected 1 to be 2"],
							fullName: "should work",
							status: "failed",
							title: "should work",
						},
					],
				},
			],
		});
		mocks.execute.mockResolvedValue(makeExecuteResult({ result: failResult }));

		vi.stubEnv("GITHUB_ACTIONS", "true");

		await run([]);

		const stderrOutput = spies.stderr.mock.calls.map(([argument]) => String(argument)).join("");

		expect(stderrOutput).not.toContain("::error");
	});
});

describe("resolveFormatters agent detection", () => {
	it("should auto-enable agent formatter when agent detected", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults();
		setupAgentDetection(true);

		await run([]);

		const formatters = mocks.formatExecuteOutput.mock.calls[0]?.[0].config.formatters;

		expect(formatters).toContain("agent");
	});

	it("should use default formatter when no agent detected", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults();

		await run([]);

		const formatters = mocks.formatExecuteOutput.mock.calls[0]?.[0].config.formatters;

		expect(formatters).toContain("default");
	});

	it("should respect explicit --formatters agent when no agent detected", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults();

		await run(["--formatters", "agent"]);

		const formatters = mocks.formatExecuteOutput.mock.calls[0]?.[0].config.formatters;

		expect(formatters).toContain("agent");
	});

	it("should respect config formatters: [agent] when no agent detected", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults({ formatters: ["agent"] });

		await run([]);

		const formatters = mocks.formatExecuteOutput.mock.calls[0]?.[0].config.formatters;

		expect(formatters).toContain("agent");
	});
});

describe("github-actions formatter", () => {
	it("should write annotations to stderr when github-actions formatter is active", async () => {
		expect.assertions(1);

		vi.stubEnv("GITHUB_STEP_SUMMARY", undefined);

		const spies = setupOutputSpies();
		setupDefaults({ formatters: ["default", "github-actions"] });
		const failResult = makeJestResult({
			numFailedTests: 1,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "src/test.spec.ts",
					testResults: [
						{
							ancestorTitles: [],
							duration: 5,
							failureMessages: ["Expected 1 to be 2"],
							fullName: "should work",
							status: "failed",
							title: "should work",
						},
					],
				},
			],
		});
		mocks.execute.mockResolvedValue(makeExecuteResult({ result: failResult }));

		const runCli = run;
		await runCli([]);

		const stderrOutput = spies.stderr.mock.calls.map(([argument]) => String(argument)).join("");

		expect(stderrOutput).toContain("::error file=src/test.spec.ts");
	});

	it("should write job summary to GITHUB_STEP_SUMMARY", async () => {
		expect.assertions(1);

		setupOutputSpies();
		vol.mkdirSync("/tmp", { recursive: true });
		vol.writeFileSync("/tmp/summary.md", "");
		onTestFinished(() => {
			vol.reset();
		});

		setupDefaults({ formatters: ["default", "github-actions"] });
		const failResult = makeJestResult({
			numFailedTests: 1,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "src/test.spec.ts",
					testResults: [
						{
							ancestorTitles: [],
							duration: 5,
							failureMessages: ["Error"],
							fullName: "should work",
							status: "failed",
							title: "should work",
						},
					],
				},
			],
		});
		mocks.execute.mockResolvedValue(makeExecuteResult({ result: failResult }));

		vi.stubEnv("GITHUB_STEP_SUMMARY", "/tmp/summary.md");

		await run([]);

		const content = vol.readFileSync("/tmp/summary.md", "utf-8") as string;

		expect(content).toContain("Test Results");
	});

	it("should support tuple format with options", async () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		setupDefaults({
			formatters: [["github-actions", { displayAnnotations: false }]],
		});
		const failResult = makeJestResult({
			numFailedTests: 1,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "src/test.spec.ts",
					testResults: [
						{
							ancestorTitles: [],
							duration: 5,
							failureMessages: ["Error"],
							fullName: "should work",
							status: "failed",
							title: "should work",
						},
					],
				},
			],
		});
		mocks.execute.mockResolvedValue(makeExecuteResult({ result: failResult }));

		const runCli = run;
		await runCli([]);

		const stderrOutput = spies.stderr.mock.calls.map(([argument]) => String(argument)).join("");

		expect(stderrOutput).not.toContain("::error");
	});

	it("should skip annotations when all tests pass", async () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		setupDefaults({ formatters: ["default", "github-actions"] });
		mocks.execute.mockResolvedValue(makeExecuteResult({ result: makeJestResult() }));

		const runCli = run;
		await runCli([]);

		const stderrOutput = spies.stderr.mock.calls.map(([argument]) => String(argument)).join("");

		expect(stderrOutput).not.toContain("::error");
	});

	it("should not write job summary when enabled is false", async () => {
		expect.assertions(1);

		setupOutputSpies();
		vol.mkdirSync("/tmp", { recursive: true });
		vol.writeFileSync("/tmp/summary.md", "");
		onTestFinished(() => {
			vol.reset();
		});

		setupDefaults({
			formatters: [["github-actions", { jobSummary: { enabled: false } }]],
		});
		mocks.execute.mockResolvedValue(makeExecuteResult());

		vi.stubEnv("GITHUB_STEP_SUMMARY", "/tmp/summary.md");

		await run([]);

		const content = vol.readFileSync("/tmp/summary.md", "utf-8") as string;

		expect(content).toBe("");
	});

	it("should write job summary to explicit outputPath", async () => {
		expect.assertions(1);

		setupOutputSpies();
		vol.mkdirSync("/tmp", { recursive: true });
		vol.writeFileSync("/tmp/custom.md", "");
		onTestFinished(() => {
			vol.reset();
		});

		setupDefaults({
			formatters: [["github-actions", { jobSummary: { outputPath: "/tmp/custom.md" } }]],
		});
		mocks.execute.mockResolvedValue(makeExecuteResult());

		const runCli = run;
		await runCli([]);

		const content = vol.readFileSync("/tmp/custom.md", "utf-8") as string;

		expect(content).toContain("Test Results");
	});

	it("should not run when github-actions is not in formatters", async () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		setupDefaults({ formatters: ["default"] });
		const failResult = makeJestResult({
			numFailedTests: 1,
			success: false,
			testResults: [
				{
					numFailingTests: 1,
					numPassingTests: 0,
					numPendingTests: 0,
					testFilePath: "src/test.spec.ts",
					testResults: [
						{
							ancestorTitles: [],
							duration: 5,
							failureMessages: ["Error"],
							fullName: "should work",
							status: "failed",
							title: "should work",
						},
					],
				},
			],
		});
		mocks.execute.mockResolvedValue(makeExecuteResult({ result: failResult }));

		const runCli = run;
		await runCli([]);

		const stderrOutput = spies.stderr.mock.calls.map(([argument]) => String(argument)).join("");

		expect(stderrOutput).not.toContain("::error");
	});
});

function makeResolvedProject(
	overrides: Partial<ResolvedProjectConfig> = {},
): ResolvedProjectConfig {
	return {
		config: makeConfig(),
		displayName: "client",
		include: ["src/client/**/*.spec.ts"],
		outDir: "out/client",
		projects: ["ReplicatedStorage/client"],
		testMatch: ["**/*.spec"],
		...overrides,
	};
}

function makeProjectEntry(name: string): InlineProjectConfig {
	return {
		test: {
			displayName: name,
			include: [`src/${name}/**/*.spec.ts`],
			outDir: `out/${name}`,
		},
	};
}

function setupMultiProjectDefaults(
	configOverrides: Partial<ResolvedConfig> = {},
	projectEntries?: Array<ProjectEntry>,
) {
	const entries: Array<ProjectEntry> = projectEntries ?? [
		makeProjectEntry("client"),
		makeProjectEntry("server"),
	];

	// loadConfig returns ResolvedConfig; at runtime the projects field
	// passes through resolveConfig as-is (Array<ProjectEntry>).
	const config = makeConfig({
		rojoProject: "default.project.json",
		...configOverrides,
	});
	const configWithProjects = {
		...config,
		projects: entries,
	} as unknown as ResolvedConfig;

	mocks.loadConfig.mockResolvedValue(configWithProjects);
	mocks.resolveAllProjects.mockResolvedValue([
		makeResolvedProject({ displayName: "client", outDir: "out/client" }),
		makeResolvedProject({ displayName: "server", outDir: "out/server" }),
	]);
	mocks.generateProjectConfigs.mockReturnValue(undefined);
	mocks.resolveBackend.mockResolvedValue(makeMockBackend("studio"));
	mocks.globSync.mockReturnValue(["/test/foo.spec.ts"]);
	mocks.execute.mockResolvedValue(makeExecuteResult());
	mocks.buildProjectJob.mockImplementation((parameters) => {
		return {
			config: parameters.config,
			displayColor: parameters.displayColor,
			displayName: parameters.displayName ?? "",
			testFiles: parameters.testFiles,
		};
	});
	mocks.executeBackend.mockImplementation(async (_backend, jobs) => makeBackendResult(jobs));
	mocks.processProjectResult.mockImplementation((entry, options) => {
		return makeExecuteResult({ result: entry.result, timing: options.backendTiming as never });
	});
	mocks.formatExecuteOutput.mockReturnValue("");
	mocks.parseGameOutput.mockReturnValue([]);
	mocks.formatGameOutputNotice.mockReturnValue("");
	mocks.loadCoverageManifest.mockReturnValue(undefined);

	// Write a fake Rojo project file for loadRojoTree
	vol.mkdirSync("/test", { recursive: true });
	vol.writeFileSync(
		"/test/default.project.json",
		JSON.stringify({ name: "test", tree: { $className: "DataModel" } }),
	);

	return { config: configWithProjects, entries };
}

describe("multi-project execution", () => {
	it("should call backend exactly once with one job per project", async () => {
		expect.assertions(3);

		setupOutputSpies();
		setupMultiProjectDefaults();
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run([]);

		expect(code).toBe(0);
		expect(mocks.executeBackend).toHaveBeenCalledOnce();

		const jobs = mocks.executeBackend.mock.calls[0]![1];

		expect(jobs).toHaveLength(2);
	});

	it("should filter by --project name", async () => {
		expect.assertions(3);

		setupOutputSpies();
		setupMultiProjectDefaults();
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run(["--project", "client"]);

		expect(code).toBe(0);
		expect(mocks.executeBackend).toHaveBeenCalledOnce();

		const jobs = mocks.executeBackend.mock.calls[0]![1];

		expect(jobs).toHaveLength(1);
	});

	it("should error on unknown --project displayName", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupMultiProjectDefaults();
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run(["--project", "nonexistent"]);

		expect(code).toBe(2);
		expect(spies.consoleError).toHaveBeenCalledWith(
			expect.stringContaining("Unknown project name(s): nonexistent"),
		);
	});

	it("should print project header between projects", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupMultiProjectDefaults();
		onTestFinished(() => {
			vol.reset();
		});

		await run([]);

		expect(spies.consoleLog).toHaveBeenCalledWith(expect.stringMatching(/▶.*client/));
		expect(spies.consoleLog).toHaveBeenCalledWith(expect.stringMatching(/▶.*server/));
	});

	it("should aggregate success/failure across projects", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults();
		onTestFinished(() => {
			vol.reset();
		});

		let callCount = 0;
		mocks.processProjectResult.mockImplementation(() => {
			callCount++;
			return callCount === 1
				? makeExecuteResult({
						result: makeJestResult({ numFailedTests: 1, success: false }),
					})
				: makeExecuteResult();
		});

		const code = await run([]);

		expect(code).toBe(1);
	});

	it("should return 2 when no test files found in any project", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupMultiProjectDefaults();
		onTestFinished(() => {
			vol.reset();
		});
		mocks.globSync.mockReturnValue([]);

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.consoleError).toHaveBeenCalledWith("No test files found in any project");
	});

	it("should return 0 when no test files found in any project and passWithNoTests is set", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupMultiProjectDefaults({ passWithNoTests: true });
		onTestFinished(() => {
			vol.reset();
		});
		mocks.globSync.mockReturnValue([]);

		const code = await run([]);

		expect(code).toBe(0);
		expect(spies.consoleError).not.toHaveBeenCalled();
	});

	it("should suppress project headers when silent", async () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		setupMultiProjectDefaults({ silent: true });
		onTestFinished(() => {
			vol.reset();
		});

		await run(["--silent"]);

		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("▶"));
	});

	it("should use agent formatter in multi-project mode", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupMultiProjectDefaults({ formatters: ["agent"] });
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run(["--formatters", "agent"]);

		expect(code).toBe(0);
		expect(spies.consoleLog).toHaveBeenCalledWith(expect.stringContaining("▶ client"));
	});

	it("should respect maxFailures from agent formatter options tuple", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupMultiProjectDefaults({ formatters: [["agent", { maxFailures: 1 }]] });
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run([]);

		expect(code).toBe(0);
		expect(spies.consoleLog).toHaveBeenCalledWith(expect.stringContaining("▶ client"));
	});

	it("should use json formatter in multi-project mode", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults({ formatters: ["json"] });
		mocks.formatExecuteOutput.mockReturnValue('{"test": true}');
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run(["--formatters", "json"]);

		expect(code).toBe(0);
	});

	it("should write outputFile in multi-project mode", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults({ outputFile: "/test/results.json" });
		onTestFinished(() => {
			vol.reset();
		});

		await run(["--outputFile", "/test/results.json"]);

		expect(mocks.writeJsonFile).toHaveBeenCalledOnce();
	});

	it("should print a notice when aggregated gameOutput is written", async () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		setupMultiProjectDefaults({ gameOutput: "/test/game.json" });
		mocks.processProjectResult.mockImplementation((entry, options) => {
			return makeExecuteResult({
				gameOutput: "raw",
				result: entry.result,
				timing: options.backendTiming as never,
			});
		});
		mocks.parseGameOutput.mockReturnValue([{ message: "hi", type: "print" }] as never);
		mocks.formatGameOutputNotice.mockReturnValue("game-output-written");
		onTestFinished(() => {
			vol.reset();
		});

		await run(["--gameOutput", "/test/game.json"]);

		expect(spies.consoleError).toHaveBeenCalledWith("game-output-written");
	});

	it("should aggregate gameOutput across projects and write it", async () => {
		// Regression: configs with projects + --gameOutput silently dropped the
		// file in multi-project mode. Per-project gameOutput entries must be
		// parsed, concatenated, and written exactly once.
		expect.assertions(2);

		setupOutputSpies();
		setupMultiProjectDefaults({ gameOutput: "/test/game.json" });
		let call = 0;
		mocks.processProjectResult.mockImplementation((entry, options) => {
			call += 1;
			return makeExecuteResult({
				gameOutput: call === 1 ? "clientRaw" : "serverRaw",
				result: entry.result,
				timing: options.backendTiming as never,
			});
		});
		mocks.parseGameOutput.mockImplementation((raw) => {
			if (raw === "clientRaw") {
				return [{ message: "from-client", type: "print" }] as never;
			}

			if (raw === "serverRaw") {
				return [{ message: "from-server", type: "print" }] as never;
			}

			return [];
		});
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run(["--gameOutput", "/test/game.json"]);

		expect(code).toBe(0);
		expect(mocks.writeGameOutput).toHaveBeenCalledWith("/test/game.json", [
			{ message: "from-client", type: "print" },
			{ message: "from-server", type: "print" },
		]);
	});

	it("should suppress gameOutput notice when a project failed", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupMultiProjectDefaults({ gameOutput: "/test/game.json" });
		let call = 0;
		mocks.processProjectResult.mockImplementation((_entry, options) => {
			call += 1;
			return makeExecuteResult({
				gameOutput: "raw",
				result: makeJestResult({
					numFailedTests: call === 1 ? 1 : 0,
					success: call !== 1,
				}),
				timing: options.backendTiming as never,
			});
		});
		mocks.parseGameOutput.mockReturnValue([{ message: "hi", type: "print" }] as never);
		mocks.formatGameOutputNotice.mockReturnValue("should-not-appear");
		onTestFinished(() => {
			vol.reset();
		});

		await run(["--gameOutput", "/test/game.json"]);

		expect(mocks.writeGameOutput).toHaveBeenCalledOnce();
		expect(spies.consoleError).not.toHaveBeenCalledWith("should-not-appear");
	});

	it("should not write gameOutput in multi-project mode when none is configured", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults();
		onTestFinished(() => {
			vol.reset();
		});

		await run([]);

		expect(mocks.writeGameOutput).not.toHaveBeenCalled();
	});

	it("should propagate per-project sourceMappers through the merged result", async () => {
		// Regression: mergeProjectResults previously dropped sourceMapper, so
		// multi-project GitHub annotations and failure output lost TS stack
		// mapping. processProjectResult must produce sourceMappers and the
		// merged ExecuteResult must keep a usable composite.
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults();
		let call = 0;
		mocks.processProjectResult.mockImplementation((entry, options) => {
			call += 1;
			const tag = call === 1 ? "CLIENT" : "SERVER";
			const mapper: SourceMapper = {
				mapFailureMessage: (message) => message.replace(tag, `${tag}_TS`),
				mapFailureWithLocations: (message) => ({ locations: [], message }),
				resolveTestFilePath: () => {},
			};
			return makeExecuteResult({
				result: entry.result,
				sourceMapper: mapper,
				timing: options.backendTiming as never,
			});
		});
		// formatMultiProject calls formatExecuteOutput indirectly; capture its
		// options to verify the merged sourceMapper survived.
		let observed: SourceMapper | undefined;
		mocks.formatExecuteOutput.mockImplementation((options) => {
			observed ??= options.sourceMapper;
			return "";
		});
		onTestFinished(() => {
			vol.reset();
		});

		await run(["--formatters", "json"]);

		expect(observed?.mapFailureMessage("CLIENT SERVER")).toBe("CLIENT_TS SERVER_TS");
	});

	it("should generate stubs with full project config fields", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults();
		mocks.resolveAllProjects.mockResolvedValue([
			makeResolvedProject({
				config: makeConfig({ clearMocks: true, testTimeout: 5000 }),
				displayName: "client",
			}),
		]);
		onTestFinished(() => {
			vol.reset();
		});

		await run([]);

		expect(mocks.generateProjectConfigs).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({
					config: expect.objectContaining({ clearMocks: true }) as unknown,
				}),
			]),
		);
	});

	it("should return 2 when Rojo project has invalid schema", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults();
		onTestFinished(() => {
			vol.reset();
		});

		// Overwrite with invalid Rojo schema (missing required "name")
		vol.writeFileSync("/test/default.project.json", JSON.stringify({ tree: "not-an-object" }));

		const code = await run([]);

		expect(code).toBe(2);
	});

	it("should default rojoProject to default.project.json when not configured", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults({ rojoProject: undefined });
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run([]);

		expect(code).toBe(0);
	});

	it("should handle projects without outDir in stub generation", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults();
		mocks.resolveAllProjects.mockResolvedValue([
			makeResolvedProject({ displayName: "luau-project", outDir: undefined }),
		]);
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run([]);

		expect(code).toBe(0);
	});

	it("should prepare coverage when collectCoverage is true", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupMultiProjectDefaults({ collectCoverage: true });
		mocks.prepareCoverage.mockReturnValue({
			manifest: {
				files: {},
				generatedAt: new Date().toISOString(),
				instrumenterVersion: 1,
				luauRoots: [],
				nonInstrumentedFiles: {},
				placeFilePath: "/coverage/game.rbxl",
				shadowDir: ".jest-roblox-coverage",
				version: 1,
			},
			placeFile: "/coverage/game.rbxl",
		});
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run(["--coverage"]);

		expect(code).toBe(0);
		expect(mocks.prepareCoverage).toHaveBeenCalledOnce();
	});

	it("should pass beforeBuild callback to prepareCoverage with coverage enabled", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults({ collectCoverage: true });
		mocks.prepareCoverage.mockReturnValue({
			manifest: {
				files: {},
				generatedAt: new Date().toISOString(),
				instrumenterVersion: 1,
				luauRoots: [],
				nonInstrumentedFiles: {},
				placeFilePath: "/coverage/game.rbxl",
				shadowDir: ".jest-roblox-coverage",
				version: 1,
			},
			placeFile: "/coverage/game.rbxl",
		});
		onTestFinished(() => {
			vol.reset();
		});

		await run(["--coverage"]);

		expect(mocks.prepareCoverage).toHaveBeenCalledWith(
			expect.objectContaining({ collectCoverage: true }),
			expect.any(Function),
		);
	});

	it("should skip buildWithRojo when coverage is enabled", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults({ collectCoverage: true });
		mocks.prepareCoverage.mockReturnValue({
			manifest: {
				files: {},
				generatedAt: new Date().toISOString(),
				instrumenterVersion: 1,
				luauRoots: [],
				nonInstrumentedFiles: {},
				placeFilePath: "/coverage/game.rbxl",
				shadowDir: ".jest-roblox-coverage",
				version: 1,
			},
			placeFile: "/coverage/game.rbxl",
		});
		onTestFinished(() => {
			vol.reset();
		});

		await run(["--coverage"]);

		expect(mocks.buildWithRojo).not.toHaveBeenCalled();
	});

	it("should call buildWithRojo when coverage is not enabled", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults();
		onTestFinished(() => {
			vol.reset();
		});

		await run([]);

		expect(mocks.buildWithRojo).toHaveBeenCalledOnce();
	});

	it("should call syncStubsToShadowDirectory via beforeBuild callback", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults({ collectCoverage: true });
		mocks.syncStubsToShadowDirectory.mockReturnValue(false);
		mocks.prepareCoverage.mockImplementation((_config, beforeBuild) => {
			if (beforeBuild !== undefined) {
				beforeBuild(".jest-roblox-coverage");
			}

			return {
				manifest: {
					files: {},
					generatedAt: new Date().toISOString(),
					instrumenterVersion: 1,
					luauRoots: [],
					nonInstrumentedFiles: {},
					placeFilePath: "/coverage/game.rbxl",
					shadowDir: ".jest-roblox-coverage",
					version: 1,
				},
				placeFile: "/coverage/game.rbxl",
			};
		});
		onTestFinished(() => {
			vol.reset();
		});

		await run(["--coverage"]);

		expect(mocks.syncStubsToShadowDirectory).toHaveBeenCalledWith(
			expect.any(Array),
			"/test",
			".jest-roblox-coverage",
		);
	});
});

describe("multi-project typecheck", () => {
	it("should run typecheck tests in multi-project mode", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupMultiProjectDefaults({ typecheck: true });
		mocks.globSync.mockReturnValue(["/test/foo.spec-d.ts"]);
		mocks.runTypecheck.mockReturnValue(makeJestResult());
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run(["--typecheck"]);

		expect(code).toBe(0);
		expect(mocks.runTypecheck).toHaveBeenCalledWith(
			expect.objectContaining({ files: ["/test/foo.spec-d.ts"] }),
		);
	});

	it("should skip runtime tests in typecheckOnly mode", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupMultiProjectDefaults({ typecheck: true, typecheckOnly: true });
		mocks.globSync.mockReturnValue(["/test/foo.spec-d.ts"]);
		mocks.runTypecheck.mockReturnValue(makeJestResult());
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run(["--typecheckOnly"]);

		expect(code).toBe(0);
		expect(mocks.executeBackend).not.toHaveBeenCalled();
	});

	it("should pass verbose options through default formatter in multi-project mode", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults({ typecheck: true, verbose: true });
		mocks.globSync.mockReturnValue(["/test/foo.spec.ts", "/test/foo.spec-d.ts"]);
		mocks.runTypecheck.mockReturnValue(makeJestResult());
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run(["--verbose", "--typecheck"]);

		expect(code).toBe(0);
	});

	it("should write typecheck summary to stderr with agent formatter", async () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		setupMultiProjectDefaults({ formatters: ["agent"], typecheck: true });
		mocks.globSync.mockReturnValue(["/test/foo.spec.ts", "/test/foo.spec-d.ts"]);
		mocks.runTypecheck.mockReturnValue(makeJestResult());
		onTestFinished(() => {
			vol.reset();
		});

		await run(["--formatters", "agent", "--typecheck"]);

		expect(spies.stderr).toHaveBeenCalledWith(expect.any(String));
	});
});

describe("multi-project Phase 4 behavior", () => {
	it("should resolve snapshotFormat per job based on project language", async () => {
		expect.assertions(3);

		setupOutputSpies();
		setupMultiProjectDefaults();
		// Stub buildProjectJob to resolve snapshotFormat by project language.
		// This mirrors the real implementation (applySnapshotFormatDefaults +
		// isLuauProject) — the point is to assert the CLI calls buildProjectJob
		// per-project and uses its output as the job config.
		mocks.buildProjectJob.mockImplementation((parameters) => {
			const isLuau = parameters.testFiles.some((file) => file.endsWith(".luau"));
			return {
				config: {
					...parameters.config,
					snapshotFormat: {
						...parameters.config.snapshotFormat,
						printBasicPrototype: isLuau,
					},
				},
				displayColor: parameters.displayColor,
				displayName: parameters.displayName ?? "",
				testFiles: parameters.testFiles,
			};
		});

		mocks.resolveAllProjects.mockResolvedValue([
			makeResolvedProject({ displayName: "ts-project", outDir: "out/ts" }),
			makeResolvedProject({ displayName: "luau-project", outDir: undefined }),
		]);
		// First project gets a TS file, second gets Luau. The stub above
		// resolves snapshotFormat from the testFiles extension.
		mocks.globSync
			.mockReturnValueOnce(["/test/a.spec.ts"])
			.mockReturnValueOnce(["/test/b.spec.luau"]);

		onTestFinished(() => {
			vol.reset();
		});

		await run([]);

		const jobs = mocks.executeBackend.mock.calls[0]![1];

		expect(jobs).toHaveLength(2);
		// TS project → printBasicPrototype = false (non-Luau)
		expect(jobs[0]?.config.snapshotFormat?.printBasicPrototype).toBe(false);
		// Luau project → printBasicPrototype = true
		expect(jobs[1]?.config.snapshotFormat?.printBasicPrototype).toBe(true);
	});

	it("should propagate displayName and displayColor on each job", async () => {
		expect.assertions(3);

		setupOutputSpies();
		setupMultiProjectDefaults();
		mocks.resolveAllProjects.mockResolvedValue([
			makeResolvedProject({
				displayColor: "red",
				displayName: "client",
				outDir: "out/client",
			}),
			makeResolvedProject({
				displayColor: "blue",
				displayName: "server",
				outDir: "out/server",
			}),
		]);
		onTestFinished(() => {
			vol.reset();
		});

		await run([]);

		const jobs = mocks.executeBackend.mock.calls[0]![1];

		expect(jobs).toHaveLength(2);
		expect(jobs[0]).toMatchObject({ displayColor: "red", displayName: "client" });
		expect(jobs[1]).toMatchObject({ displayColor: "blue", displayName: "server" });
	});

	it("should preserve per-job setupFiles and setupFilesAfterEnv", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupMultiProjectDefaults();
		mocks.createSetupResolver.mockReturnValue((input) => `resolved-${input}`);
		mocks.resolveAllProjects.mockResolvedValue([
			makeResolvedProject({
				config: makeConfig({
					setupFiles: ["./client-setup.ts"],
					setupFilesAfterEnv: ["./client-after.ts"],
				}),
				displayName: "client",
				outDir: "out/client",
			}),
			makeResolvedProject({
				config: makeConfig({
					setupFiles: ["./server-setup.ts"],
					setupFilesAfterEnv: ["./server-after.ts"],
				}),
				displayName: "server",
				outDir: "out/server",
			}),
		]);
		onTestFinished(() => {
			vol.reset();
		});

		await run([]);

		const jobs = mocks.executeBackend.mock.calls[0]![1];

		expect(jobs[0]?.config).toMatchObject({
			setupFiles: ["resolved-./client-setup.ts"],
			setupFilesAfterEnv: ["resolved-./client-after.ts"],
		});
		expect(jobs[1]?.config).toMatchObject({
			setupFiles: ["resolved-./server-setup.ts"],
			setupFilesAfterEnv: ["resolved-./server-after.ts"],
		});
	});

	it("should call backend.close in finally even when runTests throws", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupMultiProjectDefaults();
		const closeMock = vi.fn<NonNullable<Backend["close"]>>();
		const failingBackend: Backend = {
			close: closeMock,
			kind: "studio",
			runTests: vi.fn<Backend["runTests"]>(),
		};
		mocks.resolveBackend.mockResolvedValue(failingBackend);
		mocks.executeBackend.mockRejectedValue(new Error("backend blew up"));
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run([]);

		expect(code).toBe(2);
		expect(closeMock).toHaveBeenCalledOnce();
	});

	it("should call backend.close on successful multi-project run", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults();
		const closeMock = vi.fn<NonNullable<Backend["close"]>>();
		mocks.resolveBackend.mockResolvedValue({
			close: closeMock,
			kind: "studio",
			runTests: vi.fn<Backend["runTests"]>(),
		});
		onTestFinished(() => {
			vol.reset();
		});

		await run([]);

		expect(closeMock).toHaveBeenCalledOnce();
	});

	it("should forward --parallel to executeBackend when backend is open-cloud", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupMultiProjectDefaults();
		mocks.resolveBackend.mockResolvedValue({
			close: vi.fn<NonNullable<Backend["close"]>>(),
			kind: "open-cloud",
			runTests: vi.fn<Backend["runTests"]>(),
		});
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run(["--parallel", "3"]);

		expect(code).toBe(0);
		expect(mocks.executeBackend).toHaveBeenCalledWith(expect.anything(), expect.any(Array), 3);
	});

	it('should forward --parallel "auto" to executeBackend', async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults();
		mocks.resolveBackend.mockResolvedValue({
			close: vi.fn<NonNullable<Backend["close"]>>(),
			kind: "open-cloud",
			runTests: vi.fn<Backend["runTests"]>(),
		});
		onTestFinished(() => {
			vol.reset();
		});

		await run(["--parallel"]);

		expect(mocks.executeBackend).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(Array),
			"auto",
		);
	});

	it("should silently drop --parallel on studio backend (multi-project)", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupMultiProjectDefaults();
		mocks.resolveBackend.mockResolvedValue(makeMockBackend("studio"));
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run(["--parallel", "3"]);

		expect(code).toBe(0);
		expect(mocks.executeBackend).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(Array),
			undefined,
		);
	});

	it("should forward parallel from config file when flag absent", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults({ parallel: 2 });
		mocks.resolveBackend.mockResolvedValue({
			close: vi.fn<NonNullable<Backend["close"]>>(),
			kind: "open-cloud",
			runTests: vi.fn<Backend["runTests"]>(),
		});
		onTestFinished(() => {
			vol.reset();
		});

		await run([]);

		expect(mocks.executeBackend).toHaveBeenCalledWith(expect.anything(), expect.any(Array), 2);
	});

	it("should prefer CLI --parallel over config file value", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults({ parallel: 2 });
		mocks.resolveBackend.mockResolvedValue({
			close: vi.fn<NonNullable<Backend["close"]>>(),
			kind: "open-cloud",
			runTests: vi.fn<Backend["runTests"]>(),
		});
		onTestFinished(() => {
			vol.reset();
		});

		await run(["--parallel", "5"]);

		expect(mocks.executeBackend).toHaveBeenCalledWith(expect.anything(), expect.any(Array), 5);
	});

	it('should forward parallel "auto" from config file', async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults({ parallel: "auto" });
		mocks.resolveBackend.mockResolvedValue({
			close: vi.fn<NonNullable<Backend["close"]>>(),
			kind: "open-cloud",
			runTests: vi.fn<Backend["runTests"]>(),
		});
		onTestFinished(() => {
			vol.reset();
		});

		await run([]);

		expect(mocks.executeBackend).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(Array),
			"auto",
		);
	});

	it("should silently drop config parallel on studio backend (multi-project)", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupMultiProjectDefaults({ parallel: 3 });
		mocks.resolveBackend.mockResolvedValue(makeMockBackend("studio"));
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run([]);

		expect(code).toBe(0);
		expect(mocks.executeBackend).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(Array),
			undefined,
		);
	});

	it("should not pass parallel when flag is absent", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupMultiProjectDefaults();
		mocks.resolveBackend.mockResolvedValue({
			close: vi.fn<NonNullable<Backend["close"]>>(),
			kind: "open-cloud",
			runTests: vi.fn<Backend["runTests"]>(),
		});
		onTestFinished(() => {
			vol.reset();
		});

		await run([]);

		expect(mocks.executeBackend).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(Array),
			undefined,
		);
	});

	it("should use backend wall-clock for reported Duration, not sum of entries", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupMultiProjectDefaults();
		mocks.executeBackend.mockImplementation(async (_backend, jobs) => {
			return {
				results: jobs.map((job) => {
					return {
						displayName: job.displayName,
						elapsedMs: 5000,
						result: makeJestResult(),
					};
				}),
				timing: { executionMs: 1234, uploadCached: false, uploadMs: 50 },
			};
		});
		// Capture the backendTiming that gets passed to processProjectResult
		mocks.processProjectResult.mockImplementation((entry, options) => {
			return makeExecuteResult({
				result: entry.result,
				timing: {
					executionMs: options.backendTiming.executionMs,
					startTime: options.startTime,
					testsMs: 0,
					totalMs: 0,
					uploadCached: options.backendTiming.uploadCached,
					uploadMs: options.backendTiming.uploadMs,
				},
			});
		});
		onTestFinished(() => {
			vol.reset();
		});

		await run([]);

		const callArguments = mocks.processProjectResult.mock.calls;

		expect(callArguments).toHaveLength(2);
		// Both entries should receive the same backend wall-clock (1234ms),
		// NOT the sum of per-entry elapsedMs (10000ms).
		expect(
			callArguments.every(([, options]) => options.backendTiming.executionMs === 1234),
		).toBeTrue();
	});

	it("should preserve per-job order in processProjectResult calls", async () => {
		expect.assertions(3);

		setupOutputSpies();
		setupMultiProjectDefaults();
		mocks.resolveAllProjects.mockResolvedValue([
			makeResolvedProject({ displayName: "alpha", outDir: "out/a" }),
			makeResolvedProject({ displayName: "beta", outDir: "out/b" }),
		]);
		onTestFinished(() => {
			vol.reset();
		});

		await run([]);

		const jobs = mocks.executeBackend.mock.calls[0]![1];

		expect(jobs).toHaveLength(2);
		expect(jobs[0]?.displayName).toBe("alpha");
		expect(jobs[1]?.displayName).toBe("beta");
	});
});

describe("single-project Phase 4 behavior", () => {
	it("should call backend.close in finally on single-project run", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults();
		const closeMock = vi.fn<NonNullable<Backend["close"]>>();
		mocks.resolveBackend.mockResolvedValue({
			close: closeMock,
			kind: "studio",
			runTests: vi.fn<Backend["runTests"]>(),
		});

		await run([]);

		expect(closeMock).toHaveBeenCalledOnce();
	});

	it("should call backend.close even when execute throws", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults();
		const closeMock = vi.fn<NonNullable<Backend["close"]>>();
		mocks.resolveBackend.mockResolvedValue({
			close: closeMock,
			kind: "studio",
			runTests: vi.fn<Backend["runTests"]>(),
		});
		mocks.execute.mockRejectedValue(new Error("boom"));

		const code = await run([]);

		expect(code).toBe(2);
		expect(closeMock).toHaveBeenCalledOnce();
	});

	it("should silently drop --parallel on studio backend (single-project)", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.resolveBackend.mockResolvedValue(makeMockBackend("studio"));

		const code = await run(["--parallel", "3"]);

		expect(code).toBe(0);
		expect(spies.stderr).not.toHaveBeenCalledWith(
			expect.stringContaining("parallel is only supported"),
		);
	});

	it("should silently drop config parallel on studio backend (single-project)", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults({ parallel: 3 });
		mocks.resolveBackend.mockResolvedValue(makeMockBackend("studio"));

		const code = await run([]);

		expect(code).toBe(0);
		expect(spies.stderr).not.toHaveBeenCalledWith(
			expect.stringContaining("parallel is only supported"),
		);
	});
});

describe("multi-project file args", () => {
	it("should filter by positional file args in multi-project mode", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupMultiProjectDefaults();
		mocks.globSync.mockReturnValue(["/test/a.spec.ts", "/test/b.spec.ts"]);
		onTestFinished(() => {
			vol.reset();
		});

		const code = await run(["a.spec.ts"]);

		expect(code).toBe(0);

		// Jobs should receive only the specified file, not all discovered files
		const jobs = mocks.executeBackend.mock.calls[0]![1];
		const allTestFiles = jobs.flatMap((job) => job.testFiles);

		expect(allTestFiles).not.toContainEqual(expect.stringContaining("b.spec.ts"));
	});
});

describe(filterByName, () => {
	it("should filter projects by displayName", () => {
		expect.assertions(1);

		const projects = [
			makeResolvedProject({ displayName: "client" }),
			makeResolvedProject({ displayName: "server" }),
		];

		const result = filterByName(projects, ["client"]);

		expect(result).toStrictEqual([projects[0]]);
	});

	it("should throw on unknown name", () => {
		expect.assertions(1);

		const projects = [makeResolvedProject({ displayName: "client" })];

		expect(() => filterByName(projects, ["unknown"])).toThrow(
			"Unknown project name(s): unknown",
		);
	});
});

describe(mergeProjectResults, () => {
	it("should sum test counts across results", () => {
		expect.assertions(5);

		const result = mergeProjectResults([
			makeExecuteResult({
				result: makeJestResult({
					numFailedTests: 1,
					numPassedTests: 2,
					numPendingTests: 3,
					numTodoTests: 1,
					numTotalTests: 7,
				}),
			}),
			makeExecuteResult({
				result: makeJestResult({
					numFailedTests: 0,
					numPassedTests: 5,
					numPendingTests: 1,
					numTodoTests: 2,
					numTotalTests: 8,
				}),
			}),
		]);

		expect(result.result.numFailedTests).toBe(1);
		expect(result.result.numPassedTests).toBe(7);
		expect(result.result.numPendingTests).toBe(4);
		expect(result.result.numTodoTests).toBe(3);
		expect(result.result.numTotalTests).toBe(15);
	});

	it("should return success=false if any project fails", () => {
		expect.assertions(1);

		const result = mergeProjectResults([
			makeExecuteResult({
				result: makeJestResult({ success: true }),
			}),
			makeExecuteResult({
				result: makeJestResult({ success: false }),
			}),
		]);

		expect(result.result.success).toBeFalse();
	});

	it("should merge coverageData across project results", () => {
		expect.assertions(1);

		const results: Array<ExecuteResult> = [
			makeExecuteResult({
				coverageData: { "file1.luau": { s: { "0": 1 } } },
			}),
			makeExecuteResult({
				coverageData: { "file2.luau": { s: { "0": 2 } } },
			}),
		];
		const merged = mergeProjectResults(results);

		expect(merged.coverageData).toStrictEqual({
			"file1.luau": { s: { "0": 1 } },
			"file2.luau": { s: { "0": 2 } },
		});
	});

	it("should sum coverage hit counts for overlapping files", () => {
		expect.assertions(1);

		const results: Array<ExecuteResult> = [
			makeExecuteResult({
				coverageData: {
					"shared.luau": { f: { "0": 2 }, s: { "0": 1, "1": 3 } },
				},
			}),
			makeExecuteResult({
				coverageData: {
					"shared.luau": { f: { "0": 1 }, s: { "0": 4, "1": 0 } },
				},
			}),
		];
		const merged = mergeProjectResults(results);

		expect(merged.coverageData).toStrictEqual({
			"shared.luau": { f: { "0": 3 }, s: { "0": 5, "1": 3 } },
		});
	});

	it("should take executionMs from shared backend timing, not sum", () => {
		// Regression: a 3-project run where each entry carries the shared
		// backend wall-clock of 14000ms must report executionMs=14000, not
		// 42000. Summing would triple the reported Duration.
		expect.assertions(2);

		const result = mergeProjectResults([
			makeExecuteResult({
				timing: {
					executionMs: 14000,
					startTime: 1000,
					testsMs: 8000,
					totalMs: 14500,
					uploadCached: false,
					uploadMs: 500,
				},
			}),
			makeExecuteResult({
				timing: {
					executionMs: 14000,
					startTime: 1000,
					testsMs: 11000,
					totalMs: 14500,
					uploadCached: false,
					uploadMs: 500,
				},
			}),
			makeExecuteResult({
				timing: {
					executionMs: 14000,
					startTime: 1000,
					testsMs: 10000,
					totalMs: 14500,
					uploadCached: false,
					uploadMs: 500,
				},
			}),
		]);

		expect(result.timing.executionMs).toBe(14000);
		expect(result.timing.uploadMs).toBe(500);
	});

	it("should take totalMs as wall-clock max, not sum", () => {
		// Regression: per-entry totalMs is CLI wall-clock (Date.now()-startTime)
		// computed with a shared startTime. Summing 3×14000 gave 42000 which
		// is the bug the user reported.
		expect.assertions(1);

		const result = mergeProjectResults([
			makeExecuteResult({
				timing: {
					executionMs: 14000,
					startTime: 1000,
					testsMs: 5000,
					totalMs: 14000,
					uploadCached: false,
					uploadMs: 500,
				},
			}),
			makeExecuteResult({
				timing: {
					executionMs: 14000,
					startTime: 1000,
					testsMs: 5000,
					totalMs: 14010,
					uploadCached: false,
					uploadMs: 500,
				},
			}),
			makeExecuteResult({
				timing: {
					executionMs: 14000,
					startTime: 1000,
					testsMs: 5000,
					totalMs: 14005,
					uploadCached: false,
					uploadMs: 500,
				},
			}),
		]);

		expect(result.timing.totalMs).toBe(14010);
	});

	it("should take uploadMs from shared timing, not sum across entries", () => {
		// Open-Cloud does one place upload per CLI invocation. Every entry
		// sees the same uploadMs via the shared BackendTiming. Summing would
		// over-report upload cost by the project count.
		expect.assertions(2);

		const result = mergeProjectResults([
			makeExecuteResult({
				timing: {
					executionMs: 100,
					startTime: 1000,
					testsMs: 25,
					totalMs: 200,
					uploadCached: true,
					uploadMs: 500,
				},
			}),
			makeExecuteResult({
				timing: {
					executionMs: 100,
					startTime: 1000,
					testsMs: 25,
					totalMs: 200,
					uploadCached: true,
					uploadMs: 500,
				},
			}),
			makeExecuteResult({
				timing: {
					executionMs: 100,
					startTime: 1000,
					testsMs: 25,
					totalMs: 200,
					uploadCached: true,
					uploadMs: 500,
				},
			}),
		]);

		expect(result.timing.uploadMs).toBe(500);
		expect(result.timing.uploadCached).toBeTrue();
	});

	it("should pass through undefined uploadMs", () => {
		// Studio backend never sets uploadMs — ensure undefined survives merge.
		expect.assertions(1);

		const result = mergeProjectResults([
			makeExecuteResult({
				timing: {
					executionMs: 50,
					startTime: 1000,
					testsMs: 25,
					totalMs: 150,
					uploadCached: false,
					uploadMs: undefined,
				},
			}),
			makeExecuteResult({
				timing: {
					executionMs: 50,
					startTime: 1000,
					testsMs: 25,
					totalMs: 150,
					uploadCached: false,
					uploadMs: undefined,
				},
			}),
		]);

		expect(result.timing.uploadMs).toBeUndefined();
	});

	it("should sum testsMs across projects (CPU time)", () => {
		// testsMs is per-project in-Luau test CPU time — summing is honest
		// even when wall-clock overlaps, because it reports "tests did N ms
		// of work" across all projects.
		expect.assertions(1);

		const result = mergeProjectResults([
			makeExecuteResult({
				timing: {
					executionMs: 14000,
					startTime: 1000,
					testsMs: 8000,
					totalMs: 14000,
					uploadCached: false,
					uploadMs: 500,
				},
			}),
			makeExecuteResult({
				timing: {
					executionMs: 14000,
					startTime: 1000,
					testsMs: 11000,
					totalMs: 14000,
					uploadCached: false,
					uploadMs: 500,
				},
			}),
			makeExecuteResult({
				timing: {
					executionMs: 14000,
					startTime: 1000,
					testsMs: 10000,
					totalMs: 14000,
					uploadCached: false,
					uploadMs: 500,
				},
			}),
		]);

		expect(result.timing.testsMs).toBe(29000);
	});

	it("should pass through coverageMs from shared timing", () => {
		// Per-entry coverageMs is currently always undefined (coverage cost
		// is injected post-merge via addCoverageTiming). Defensive: if set,
		// take it from the first entry, don't sum.
		expect.assertions(1);

		const result = mergeProjectResults([
			makeExecuteResult({
				timing: {
					coverageMs: 100,
					executionMs: 50,
					startTime: 1000,
					testsMs: 25,
					totalMs: 150,
					uploadCached: false,
					uploadMs: undefined,
				},
			}),
			makeExecuteResult({
				timing: {
					coverageMs: 100,
					executionMs: 50,
					startTime: 1000,
					testsMs: 25,
					totalMs: 150,
					uploadCached: false,
					uploadMs: undefined,
				},
			}),
		]);

		expect(result.timing.coverageMs).toBe(100);
	});

	it("should use earliest startTime", () => {
		expect.assertions(1);

		const result = mergeProjectResults([
			makeExecuteResult({
				result: makeJestResult({ startTime: 2000 }),
			}),
			makeExecuteResult({
				result: makeJestResult({ startTime: 1000 }),
			}),
		]);

		expect(result.result.startTime).toBe(1000);
	});

	it("should sum setupMs across projects", () => {
		expect.assertions(1);

		const result = mergeProjectResults([
			makeExecuteResult({
				timing: {
					executionMs: 100,
					setupMs: 50,
					startTime: 1000,
					testsMs: 30,
					totalMs: 200,
				},
			}),
			makeExecuteResult({
				timing: {
					executionMs: 100,
					setupMs: 75,
					startTime: 1000,
					testsMs: 30,
					totalMs: 200,
				},
			}),
		]);

		expect(result.timing.setupMs).toBe(125);
	});

	it("should omit setupMs when no project has it", () => {
		expect.assertions(1);

		const result = mergeProjectResults([makeExecuteResult(), makeExecuteResult()]);

		expect(result.timing.setupMs).toBeUndefined();
	});

	it("should combine per-project sourceMappers into a composite", () => {
		// Multi-project runs must preserve source mapping — otherwise TS stack
		// frames in failure output and GitHub annotations fall back to Luau
		// paths. The merged sourceMapper should delegate to each child.
		expect.assertions(3);

		const mapperA: SourceMapper = {
			mapFailureMessage: (message) => message.replace("A_LUAU", "A_TS"),
			mapFailureWithLocations: (message) => {
				return {
					locations: [{ luauLine: 1, luauPath: "a.luau", tsPath: "a.ts" }],
					message: message.replace("A_LUAU", "A_TS"),
				};
			},
			resolveTestFilePath: (file) => (file === "a.spec" ? "a.spec.ts" : undefined),
		};
		const mapperB: SourceMapper = {
			mapFailureMessage: (message) => message.replace("B_LUAU", "B_TS"),
			mapFailureWithLocations: (message) => {
				return {
					locations: [{ luauLine: 2, luauPath: "b.luau", tsPath: "b.ts" }],
					message: message.replace("B_LUAU", "B_TS"),
				};
			},
			resolveTestFilePath: (file) => (file === "b.spec" ? "b.spec.ts" : undefined),
		};

		const result = mergeProjectResults([
			makeExecuteResult({ sourceMapper: mapperA }),
			makeExecuteResult({ sourceMapper: mapperB }),
		]);

		expect(result.sourceMapper?.mapFailureMessage("A_LUAU B_LUAU")).toBe("A_TS B_TS");
		expect(result.sourceMapper?.resolveTestFilePath("b.spec")).toBe("b.spec.ts");

		const withLocations = result.sourceMapper?.mapFailureWithLocations("A_LUAU B_LUAU");

		expect(withLocations?.locations).toHaveLength(2);
	});

	it("should return the single sourceMapper unchanged when only one result has it", () => {
		expect.assertions(1);

		const mapper: SourceMapper = {
			mapFailureMessage: (message) => `mapped:${message}`,
			mapFailureWithLocations: (message) => ({ locations: [], message }),
			resolveTestFilePath: () => {},
		};

		const result = mergeProjectResults([
			makeExecuteResult({ sourceMapper: mapper }),
			makeExecuteResult({ sourceMapper: undefined }),
		]);

		expect(result.sourceMapper?.mapFailureMessage("hi")).toBe("mapped:hi");
	});

	it("should leave sourceMapper undefined when no project provides one", () => {
		expect.assertions(1);

		const result = mergeProjectResults([makeExecuteResult(), makeExecuteResult()]);

		expect(result.sourceMapper).toBeUndefined();
	});
});
