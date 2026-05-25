import { NetworkError } from "@bedrock-rbx/ocale";

import process from "node:process";
import type { MockInstance } from "vitest";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { main, parseArgs, run } from "./cli.ts";
import { ConfigError } from "./config/errors.ts";
import { loadConfig } from "./config/loader.ts";
import { DEFAULT_CONFIG, type ResolvedConfig } from "./config/schema.ts";
import type { ExecuteResult } from "./executor.ts";
import { outputMultiResult, outputSingleResult } from "./output.ts";
import { LuauScriptError } from "./reporter/parser.ts";
import { runJestRoblox } from "./run.ts";
import type {
	MultiRunResult,
	ProjectResult,
	SingleRunResult,
	WorkspaceRunResult,
} from "./run/types.ts";
import type { JestResult } from "./types/jest-result.ts";

vi.mock(import("./config/loader"));
vi.mock(import("./run"));
vi.mock(import("./output"));

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

const mocks = {
	loadConfig: vi.mocked(loadConfig),
	outputMultiResult: vi.mocked(outputMultiResult),
	outputSingleResult: vi.mocked(outputSingleResult),
	runJestRoblox: vi.mocked(runJestRoblox),
};

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
			uploadMs: 50,
		},
		...overrides,
	};
}

function makeSingleResult(overrides: Partial<SingleRunResult> = {}): SingleRunResult {
	return {
		mode: "single",
		preCoverageMs: 0,
		runtimeResult: makeExecuteResult(),
		...overrides,
	};
}

function makeProjectResult(displayName = "client"): ProjectResult {
	return {
		displayName,
		result: makeExecuteResult(),
	};
}

function makeMultiResult(overrides: Partial<MultiRunResult> = {}): MultiRunResult {
	return {
		merged: {},
		mode: "multi",
		preCoverageMs: 0,
		projectResults: [makeProjectResult()],
		...overrides,
	};
}

function makeWorkspaceResult(overrides: Partial<WorkspaceRunResult> = {}): WorkspaceRunResult {
	return {
		merged: {},
		mode: "workspace",
		preCoverageMs: 0,
		projectResults: [makeProjectResult("@halcyon/foo")],
		...overrides,
	};
}

function setupOutputSpies(): OutputSpies {
	return {
		consoleError: vi.spyOn(console, "error").mockImplementation(() => {}),
		consoleLog: vi.spyOn(console, "log").mockImplementation(() => {}),
		stderr: vi.spyOn(process.stderr, "write").mockReturnValue(true),
		stdout: vi.spyOn(process.stdout, "write").mockReturnValue(true),
	};
}

function setupDefaults(configOverrides: Partial<ResolvedConfig> = {}) {
	const config = makeConfig(configOverrides);
	mocks.loadConfig.mockResolvedValue(config);
	mocks.runJestRoblox.mockResolvedValue(makeSingleResult());
	mocks.outputSingleResult.mockResolvedValue(0);
	mocks.outputMultiResult.mockResolvedValue(0);
	return { config };
}

describe(parseArgs, () => {
	it("should return help when --help is passed", () => {
		expect.assertions(1);
		expect(parseArgs(["--help"]).help).toBeTrue();
	});

	it("should return version when --version is passed", () => {
		expect.assertions(1);
		expect(parseArgs(["--version"]).version).toBeTrue();
	});

	it("should parse --config option", () => {
		expect.assertions(1);
		expect(parseArgs(["--config", "./custom.config.ts"]).config).toBe("./custom.config.ts");
	});

	it("should parse --testPathPattern option", () => {
		expect.assertions(1);
		expect(parseArgs(["--testPathPattern", "player"]).testPathPattern).toBe("player");
	});

	it("should parse -t / --testNamePattern option", () => {
		expect.assertions(2);
		expect(parseArgs(["-t", "should spawn"]).testNamePattern).toBe("should spawn");
		expect(parseArgs(["--testNamePattern", "should spawn"]).testNamePattern).toBe(
			"should spawn",
		);
	});

	it("should parse --formatters json", () => {
		expect.assertions(1);
		expect(parseArgs(["--formatters", "json"]).formatters).toStrictEqual(["json"]);
	});

	it("should parse --outputFile option", () => {
		expect.assertions(1);
		expect(parseArgs(["--outputFile", "results.json"]).outputFile).toBe("results.json");
	});

	it("should parse --verbose flag", () => {
		expect.assertions(1);
		expect(parseArgs(["--verbose"]).verbose).toBeTrue();
	});

	it("should parse --silent flag", () => {
		expect.assertions(1);
		expect(parseArgs(["--silent"]).silent).toBeTrue();
	});

	it("should parse positional file arguments", () => {
		expect.assertions(1);

		const result = parseArgs(["src/test.spec.ts", "src/other.spec.ts"]);

		expect(result.files).toStrictEqual(["src/test.spec.ts", "src/other.spec.ts"]);
	});

	it("should leave files undefined when no positionals", () => {
		expect.assertions(1);
		expect(parseArgs([]).files).toBeUndefined();
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
		expect(parseArgs(["--formatters", "agent"]).formatters).toStrictEqual(["agent"]);
	});

	it("should reject --no-cache as an unknown option", () => {
		expect.assertions(1);
		expect(() => parseArgs(["--no-cache"])).toThrow(/Unknown option/);
	});

	it("should reject --cache as an unknown option", () => {
		expect.assertions(1);
		expect(() => parseArgs(["--cache"])).toThrow(/Unknown option/);
	});

	it("should parse --no-coverage-cache flag", () => {
		expect.assertions(1);
		expect(parseArgs(["--no-coverage-cache"]).coverageCache).toBeFalse();
	});

	it("should parse --no-color flag", () => {
		expect.assertions(1);
		expect(parseArgs(["--no-color"]).color).toBeFalse();
	});

	it("should parse --gameOutput option", () => {
		expect.assertions(1);
		expect(parseArgs(["--gameOutput", "/tmp/game.json"]).gameOutput).toBe("/tmp/game.json");
	});

	it("should parse --no-show-luau flag", () => {
		expect.assertions(1);
		expect(parseArgs(["--no-show-luau"]).showLuau).toBeFalse();
	});

	it("should parse -u / --updateSnapshot flag", () => {
		expect.assertions(2);
		expect(parseArgs(["-u"]).updateSnapshot).toBeTrue();
		expect(parseArgs(["--updateSnapshot"]).updateSnapshot).toBeTrue();
	});

	it("should parse --typecheck flag", () => {
		expect.assertions(1);
		expect(parseArgs(["--typecheck"]).typecheck).toBeTrue();
	});

	it("should parse --typecheckOnly flag and imply --typecheck", () => {
		expect.assertions(2);

		const result = parseArgs(["--typecheckOnly"]);

		expect(result.typecheckOnly).toBeTrue();
		expect(result.typecheck).toBeTrue();
	});

	it("should parse --typecheckTsconfig option", () => {
		expect.assertions(1);
		expect(parseArgs(["--typecheckTsconfig", "tsconfig.test.json"]).typecheckTsconfig).toBe(
			"tsconfig.test.json",
		);
	});

	it("should parse valid --backend values", () => {
		expect.assertions(3);
		expect(parseArgs(["--backend", "auto"]).backend).toBe("auto");
		expect(parseArgs(["--backend", "open-cloud"]).backend).toBe("open-cloud");
		expect(parseArgs(["--backend", "studio"]).backend).toBe("studio");
	});

	it("should leave backend undefined when not passed", () => {
		expect.assertions(1);
		expect(parseArgs([]).backend).toBeUndefined();
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
		expect(parseArgs(["--coverage"]).collectCoverage).toBeTrue();
	});

	it("should parse --coverageDirectory option", () => {
		expect.assertions(1);
		expect(parseArgs(["--coverageDirectory", "my-coverage"]).coverageDirectory).toBe(
			"my-coverage",
		);
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
		expect(parseArgs([]).collectCoverageFrom).toBeUndefined();
	});

	it("should parse --port option", () => {
		expect.assertions(2);
		expect(parseArgs(["--port", "4000"]).port).toBe(4000);
		expect(parseArgs([]).port).toBeUndefined();
	});

	it("should parse --timeout option", () => {
		expect.assertions(2);
		expect(parseArgs(["--timeout", "60000"]).timeout).toBe(60000);
		expect(parseArgs([]).timeout).toBeUndefined();
	});

	it("should parse single --project flag", () => {
		expect.assertions(1);
		expect(parseArgs(["--project", "client"]).project).toStrictEqual(["client"]);
	});

	it("should parse multiple --project flags", () => {
		expect.assertions(1);

		const result = parseArgs(["--project", "client", "--project", "server"]);

		expect(result.project).toStrictEqual(["client", "server"]);
	});

	it("should parse --passWithNoTests flag", () => {
		expect.assertions(1);
		expect(parseArgs(["--passWithNoTests"]).passWithNoTests).toBeTrue();
	});

	it("should parse --parallel with integer value", () => {
		expect.assertions(1);
		expect(parseArgs(["--parallel", "3"]).parallel).toBe(3);
	});

	it('should parse --parallel with "auto"', () => {
		expect.assertions(1);
		expect(parseArgs(["--parallel", "auto"]).parallel).toBe("auto");
	});

	it('should treat bare --parallel (no value) as "auto"', () => {
		expect.assertions(1);
		expect(parseArgs(["--parallel"]).parallel).toBe("auto");
	});

	it("should treat --parallel followed by another flag as auto", () => {
		expect.assertions(2);

		const result = parseArgs(["--parallel", "--verbose"]);

		expect(result.parallel).toBe("auto");
		expect(result.verbose).toBeTrue();
	});

	it("should leave parallel undefined when flag not present", () => {
		expect.assertions(1);
		expect(parseArgs([]).parallel).toBeUndefined();
	});

	it("should throw on --parallel 0", () => {
		expect.assertions(1);
		expect(() => parseArgs(["--parallel", "0"])).toThrow("Invalid --parallel value");
	});

	it("should throw on --parallel -1", () => {
		expect.assertions(1);
		expect(() => parseArgs(["--parallel=-1"])).toThrow("Invalid --parallel value");
	});

	it("should throw on --parallel non-numeric", () => {
		expect.assertions(1);
		expect(() => parseArgs(["--parallel=xyz"])).toThrow("Invalid --parallel value");
	});

	it("should parse --apiKey option", () => {
		expect.assertions(1);
		expect(parseArgs(["--apiKey", "secret"]).apiKey).toBe("secret");
	});

	it("should parse --universeId option", () => {
		expect.assertions(1);
		expect(parseArgs(["--universeId", "123"]).universeId).toBe("123");
	});

	it("should parse --placeId option", () => {
		expect.assertions(1);
		expect(parseArgs(["--placeId", "456"]).placeId).toBe("456");
	});

	it("should parse all three credential flags together", () => {
		expect.assertions(3);

		const result = parseArgs(["--apiKey", "secret", "--universeId", "123", "--placeId", "456"]);

		expect(result.apiKey).toBe("secret");
		expect(result.universeId).toBe("123");
		expect(result.placeId).toBe("456");
	});

	it("should leave credential fields undefined when flags are absent", () => {
		expect.assertions(3);

		const result = parseArgs([]);

		expect(result.apiKey).toBeUndefined();
		expect(result.universeId).toBeUndefined();
		expect(result.placeId).toBeUndefined();
	});

	it("should parse --workspace flag", () => {
		expect.assertions(1);
		expect(parseArgs(["--workspace"]).workspace).toBeTrue();
	});

	it("should parse --packages option", () => {
		expect.assertions(1);
		expect(parseArgs(["--packages", "foo,bar"]).packages).toBe("foo,bar");
	});

	it("should parse --affected-since option", () => {
		expect.assertions(1);
		expect(parseArgs(["--affected-since", "main"]).affectedSince).toBe("main");
	});

	it("should parse --workspace-root option", () => {
		expect.assertions(1);
		expect(parseArgs(["--workspace-root", "./pkgs/testing"]).workspaceRoot).toBe(
			"./pkgs/testing",
		);
	});

	it("should parse --setupFiles list", () => {
		expect.assertions(1);

		const result = parseArgs(["--setupFiles", "a.ts", "--setupFiles", "b.ts"]);

		expect(result.setupFiles).toStrictEqual(["a.ts", "b.ts"]);
	});

	it("should parse --setupFilesAfterEnv list", () => {
		expect.assertions(1);

		const result = parseArgs(["--setupFilesAfterEnv", "x.ts", "--setupFilesAfterEnv", "y.ts"]);

		expect(result.setupFilesAfterEnv).toStrictEqual(["x.ts", "y.ts"]);
	});

	it("should parse --rojoProject option", () => {
		expect.assertions(1);
		expect(parseArgs(["--rojoProject", "custom.project.json"]).rojoProject).toBe(
			"custom.project.json",
		);
	});

	it("should parse --sourceMap flag", () => {
		expect.assertions(1);
		expect(parseArgs(["--sourceMap"]).sourceMap).toBeTrue();
	});
});

describe(run, () => {
	it("should return 2 and print banner for ConfigError with hint", async () => {
		expect.assertions(3);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.loadConfig.mockRejectedValue(new ConfigError("bad value", "try this instead"));

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("bad value"));
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("Hint:"));
	});

	it("should return 2 and print banner for ConfigError without hint", async () => {
		expect.assertions(3);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.loadConfig.mockRejectedValue(new ConfigError("missing field"));

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("missing field"));
		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("Hint:"));
	});

	it("should return 2 and print hint for LuauScriptError matching a known pattern", async () => {
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

	it("should omit Hint section for LuauScriptError with no matching pattern", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.loadConfig.mockRejectedValue(new LuauScriptError("Some unrelated runtime error"));

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("Hint:"));
	});

	it("should lead the banner with captured banner output when the message is just an exit code", async () => {
		// When Jest exits via process.exit(N), the message "Exited
		// with code: N" is only a transport — the real error message Jest
		// printed to stdout lives in `bannerOutput` (the InterceptWriteable
		// capture, distinct from the LogService-sourced `gameOutput` dump).
		// Lead the banner with that.
		expect.assertions(5);

		const spies = setupOutputSpies();
		setupDefaults();

		const error = new LuauScriptError("Exited with code: 1");
		error.bannerOutput = JSON.stringify([
			{ message: "No tests found, exiting with code 1", messageType: 0, timestamp: 0 },
			{
				message: "Run with `--passWithNoTests` to exit with code 0",
				messageType: 0,
				timestamp: 0,
			},
		]);
		mocks.loadConfig.mockRejectedValue(error);

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("Test Run Failed"));
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("No tests found"));
		// Game output is the primary content now, not a sub-section.
		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("Game output:"));
		// "Luau Error" title is reserved for actual Luau crashes.
		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("Luau Error"));
	});

	it("should print banner output context for LuauScriptError with parseable bannerOutput", async () => {
		// Non-exit-code LuauScriptError (e.g. config / Jest-resolution failure)
		// keeps the original layout: message as primary, bannerOutput as hint.
		expect.assertions(3);

		const spies = setupOutputSpies();
		setupDefaults();

		const error = new LuauScriptError("Failed to find Jest instance in ReplicatedStorage");
		error.bannerOutput = JSON.stringify([
			{ message: "diagnostic output", messageType: 0, timestamp: 0 },
		]);
		mocks.loadConfig.mockRejectedValue(error);

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("Luau Error"));
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("Game output:"));
	});

	it("should omit Game output section when bannerOutput parses to empty array", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults();

		const error = new LuauScriptError("Exited with code: 1");
		error.bannerOutput = "[]";
		mocks.loadConfig.mockRejectedValue(error);

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("Game output:"));
	});

	it("should omit Game output section when gameOutput is undefined", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.loadConfig.mockRejectedValue(new LuauScriptError("Exited with code: 1"));

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

	it("should return 2 for unknown error type", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.loadConfig.mockRejectedValue("string-error");

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.consoleError).toHaveBeenCalledWith("An unknown error occurred");
	});

	it("should return 2 and render a Backend Error banner when error.cause is an OpenCloudError", async () => {
		expect.assertions(3);

		const spies = setupOutputSpies();
		setupDefaults();
		const wrapped = new Error("Failed to upload place: Network request failed", {
			cause: new NetworkError("Network request failed"),
		});
		mocks.loadConfig.mockRejectedValue(wrapped);

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("Backend Error"));
		expect(spies.stderr).toHaveBeenCalledWith(
			expect.stringContaining("Failed to upload place: Network request failed"),
		);
	});

	it("should include the cause chain entries inside the Backend Error banner", async () => {
		expect.assertions(4);

		const spies = setupOutputSpies();
		setupDefaults();
		const innerWithCode = Object.assign(new TypeError("fetch failed"), {
			code: "ECONNRESET",
			errno: -54,
			syscall: "connect",
		});
		const wrapped = new Error("Failed to upload place: Network request failed", {
			cause: new NetworkError("Network request failed", { cause: innerWithCode }),
		});
		mocks.loadConfig.mockRejectedValue(wrapped);

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("Caused by:"));
		expect(spies.stderr).toHaveBeenCalledWith(
			expect.stringContaining("NetworkError: Network request failed"),
		);
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("ECONNRESET"));
	});

	it("should fall through to plain console.error when error.cause is not an OpenCloudError", async () => {
		expect.assertions(3);

		const spies = setupOutputSpies();
		setupDefaults();
		const wrapped = new Error("wrapped non-ocale", {
			cause: new Error("inner non-ocale"),
		});
		mocks.loadConfig.mockRejectedValue(wrapped);

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.consoleError).toHaveBeenCalledWith("Error: wrapped non-ocale");
		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("Backend Error"));
	});
});

describe("lUAU_ERROR_HINTS", () => {
	it.for<[message: string, hintFragment: string]>([
		["Failed to find Jest instance in ReplicatedStorage", "jestPath"],
		["Failed to find Jest instance at path", "configured jestPath"],
		["Failed to find service ReplicatedStorage.foo", "valid Roblox service"],
		["No projects configured", "projects"],
		["Infinite yield detected", "WaitForChild"],
		["loadstring() is not available", "loadstring"],
	])("should hint for: %s", async ([message, fragment]) => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.loadConfig.mockRejectedValue(new LuauScriptError(message));

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining(fragment));
	});

	it("should not reference removed --projects flag in projects hint", async () => {
		expect.assertions(3);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.loadConfig.mockRejectedValue(new LuauScriptError("No projects configured"));

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("projects"));
		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("--projects"));
	});
});

describe(main, () => {
	it("should set process.exitCode from the run result", async () => {
		expect.assertions(1);

		setupDefaults();
		setupOutputSpies();

		const originalArgv = process.argv;
		const originalExitCode = process.exitCode;
		process.argv = ["node", "jest-roblox"];

		onTestFinished(() => {
			process.argv = originalArgv;
			process.exitCode = originalExitCode;
		});

		await main();

		expect(process.exitCode).toBe(0);
	});
});

describe("runInner orchestration", () => {
	it("should print HELP_TEXT and return 0 when --help is passed", async () => {
		expect.assertions(3);

		const spies = setupOutputSpies();
		setupDefaults();

		const code = await run(["--help"]);

		expect(code).toBe(0);
		expect(spies.consoleLog).toHaveBeenCalledWith(
			expect.stringContaining("Usage: jest-roblox"),
		);
		expect(mocks.loadConfig).not.toHaveBeenCalled();
	});

	it("should print VERSION and return 0 when --version is passed", async () => {
		expect.assertions(3);

		const spies = setupOutputSpies();
		setupDefaults();

		const code = await run(["--version"]);

		expect(code).toBe(0);
		expect(spies.consoleLog).toHaveBeenCalledOnce();
		expect(mocks.loadConfig).not.toHaveBeenCalled();
	});

	it("should throw a ConfigError when SEA mode is paired with --typecheck", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults();

		const previous = process.env["JEST_ROBLOX_SEA"];
		process.env["JEST_ROBLOX_SEA"] = "true";
		onTestFinished(() => {
			if (previous === undefined) {
				delete process.env["JEST_ROBLOX_SEA"];
			} else {
				process.env["JEST_ROBLOX_SEA"] = previous;
			}
		});

		const code = await run(["--typecheck"]);

		expect(code).toBe(2);
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("standalone binary"));
	});

	it("should call loadConfig with --config path", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults();

		await run(["--config", "./custom.ts"]);

		expect(mocks.loadConfig).toHaveBeenCalledWith("./custom.ts", undefined);
	});

	it("should load the bootstrap config from --workspace-root", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults();

		await run(["--workspace", "--packages", "foo", "--workspace-root", "/ws"]);

		expect(mocks.loadConfig).toHaveBeenCalledWith(undefined, "/ws");
	});

	it("should pass cli flags into runJestRoblox", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults();

		await run(["--verbose"]);

		expect(mocks.runJestRoblox).toHaveBeenCalledOnce();

		const [cli] = mocks.runJestRoblox.mock.calls[0]!;

		expect(cli.verbose).toBeTrue();
	});

	it("should dispatch SingleRunResult to outputSingleResult", async () => {
		expect.assertions(3);

		setupOutputSpies();
		setupDefaults();
		const single = makeSingleResult();
		mocks.runJestRoblox.mockResolvedValue(single);
		mocks.outputSingleResult.mockResolvedValue(0);

		const code = await run([]);

		expect(code).toBe(0);
		expect(mocks.outputSingleResult).toHaveBeenCalledWith(expect.any(Object), single);
		expect(mocks.outputMultiResult).not.toHaveBeenCalled();
	});

	it("should propagate non-zero exit code from outputSingleResult", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults();
		mocks.outputSingleResult.mockResolvedValue(1);

		const code = await run([]);

		expect(code).toBe(1);
	});

	it("should dispatch MultiRunResult to outputMultiResult", async () => {
		expect.assertions(3);

		setupOutputSpies();
		setupDefaults();
		const multi = makeMultiResult();
		mocks.runJestRoblox.mockResolvedValue(multi);

		const code = await run([]);

		expect(code).toBe(0);
		expect(mocks.outputMultiResult).toHaveBeenCalledWith(expect.any(Object), multi);
		expect(mocks.outputSingleResult).not.toHaveBeenCalled();
	});

	it("should dispatch WorkspaceRunResult to outputMultiResult", async () => {
		expect.assertions(3);

		setupOutputSpies();
		setupDefaults();
		const workspace = makeWorkspaceResult();
		mocks.runJestRoblox.mockResolvedValue(workspace);

		const code = await run([]);

		expect(code).toBe(0);
		expect(mocks.outputMultiResult).toHaveBeenCalledWith(expect.any(Object), workspace);
		expect(mocks.outputSingleResult).not.toHaveBeenCalled();
	});

	it("should write validationMessage to stderr and return validationExitCode", async () => {
		expect.assertions(4);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.runJestRoblox.mockResolvedValue(
			makeWorkspaceResult({
				projectResults: [],
				validationExitCode: 2,
				validationMessage: "Error: --workspace requires --packages.\n",
			}),
		);

		const code = await run(["--workspace"]);

		expect(code).toBe(2);
		expect(spies.stderr).toHaveBeenCalledWith("Error: --workspace requires --packages.\n");
		expect(mocks.outputMultiResult).not.toHaveBeenCalled();
		expect(mocks.outputSingleResult).not.toHaveBeenCalled();
	});

	it("should not write to stderr when validationMessage is undefined", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		setupDefaults();
		mocks.runJestRoblox.mockResolvedValue(
			makeMultiResult({ projectResults: [], validationExitCode: 2 }),
		);

		const code = await run([]);

		expect(code).toBe(2);
		expect(spies.stderr).not.toHaveBeenCalled();
	});

	it("should return 0 for workspace with empty projectResults (no validation error)", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults();
		mocks.runJestRoblox.mockResolvedValue(makeWorkspaceResult({ projectResults: [] }));

		const code = await run(["--workspace", "--affected-since", "main"]);

		expect(code).toBe(0);
		expect(mocks.outputMultiResult).not.toHaveBeenCalled();
	});

	it("should return 0 for single mode with no runtime and no typecheck result", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults();
		mocks.runJestRoblox.mockResolvedValue(
			makeSingleResult({ runtimeResult: undefined, typecheckResult: undefined }),
		);

		const code = await run([]);

		expect(code).toBe(0);
		expect(mocks.outputSingleResult).not.toHaveBeenCalled();
	});

	it("should dispatch single mode with only typecheckResult", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults();
		mocks.runJestRoblox.mockResolvedValue(
			makeSingleResult({
				runtimeResult: undefined,
				typecheckResult: makeJestResult(),
			}),
		);

		const code = await run(["--typecheckOnly"]);

		expect(code).toBe(0);
		expect(mocks.outputSingleResult).toHaveBeenCalledOnce();
	});

	it("should return 0 for multi mode with empty projects and no typecheck", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults();
		mocks.runJestRoblox.mockResolvedValue(makeMultiResult({ projectResults: [] }));

		const code = await run([]);

		expect(code).toBe(0);
		expect(mocks.outputMultiResult).not.toHaveBeenCalled();
	});

	it("should dispatch multi mode with empty projects but typecheck present", async () => {
		expect.assertions(2);

		setupOutputSpies();
		setupDefaults();
		mocks.runJestRoblox.mockResolvedValue(
			makeMultiResult({ projectResults: [], typecheckResult: makeJestResult() }),
		);

		const code = await run([]);

		expect(code).toBe(0);
		expect(mocks.outputMultiResult).toHaveBeenCalledOnce();
	});

	it("should pass explicit --formatters through merge into config", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults();

		await run(["--formatters", "json"]);

		const [, config] = mocks.runJestRoblox.mock.calls[0]!;

		expect(config.formatters).toStrictEqual(["json"]);
	});

	it("should default formatters to agent when std-env reports agent", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults();

		stdEnvironmentMock.isAgent = true;
		onTestFinished(() => {
			stdEnvironmentMock.isAgent = false;
		});

		await run([]);

		const [, config] = mocks.runJestRoblox.mock.calls[0]!;

		expect(config.formatters).toContain("agent");
	});

	it("should default formatters to github-actions when GITHUB_ACTIONS env is true", async () => {
		expect.assertions(1);

		setupOutputSpies();
		setupDefaults();

		const previous = process.env["GITHUB_ACTIONS"];
		process.env["GITHUB_ACTIONS"] = "true";
		onTestFinished(() => {
			if (previous === undefined) {
				delete process.env["GITHUB_ACTIONS"];
			} else {
				process.env["GITHUB_ACTIONS"] = previous;
			}
		});

		await run([]);

		const [, config] = mocks.runJestRoblox.mock.calls[0]!;

		expect(config.formatters).toContain("github-actions");
	});
});
