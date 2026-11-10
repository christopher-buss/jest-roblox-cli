import { TaskStallError } from "@isentinel/roblox-runner";
import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import { expectedDefaultFormatters } from "#test/mocks/config-default-formatters.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { OutputSpies } from "#test/mocks/spec-results.ts";
import { makeExecuteResult, makeJestResult, setupOutputSpies } from "#test/mocks/spec-results.ts";
import packageJson from "../package.json" with { type: "json" };
import type { CliDependencies } from "./cli.ts";
import { main, runAsync } from "./cli.ts";
import { ConfigError } from "./config/errors.ts";
import type { ResolvedConfig } from "./config/resolved-config.ts";
import type { ProjectResult, RunResult } from "./results/run-result-types.ts";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...createResolvedConfig(),
		rootDir: "/test",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

function makeProjectResult(displayName = "client"): ProjectResult {
	return {
		displayName,
		result: makeExecuteResult(),
	};
}

function makeMultiResult(overrides: Partial<RunResult> = {}): RunResult {
	return {
		coverageMs: 0,
		output: fromAny({ formatters: ["default"], rootDir: "/test", verbose: false }),
		projectResults: [makeProjectResult()],
		stagingMs: 0,
		...overrides,
	};
}

function makeWorkspaceResult(overrides: Partial<RunResult> = {}): RunResult {
	return {
		coverageMs: 0,
		output: fromAny({ formatters: ["default"], rootDir: "/test", verbose: false }),
		projectResults: [makeProjectResult("@halcyon/foo")],
		stagingMs: 0,
		...overrides,
	};
}

function setupDefaults(configOverrides: Partial<ResolvedConfig> = {}) {
	const { fileSystem } = createMemoryFileSystem({ "/test/default.project.json": "{}" });
	const loadConfig = vi
		.fn<NonNullable<CliDependencies["loadConfig"]>>()
		.mockResolvedValue(makeConfig(configOverrides));
	const outputRun = vi.fn<NonNullable<CliDependencies["outputRun"]>>().mockResolvedValue(0);
	const runJestRoblox = vi
		.fn<NonNullable<CliDependencies["runJestRoblox"]>>()
		.mockResolvedValue(makeMultiResult());
	const dependencies: CliDependencies = {
		fileSystem,
		loadConfig,
		outputRun,
		runJestRoblox,
	};

	return { dependencies, fileSystem, loadConfig, outputRun, runJestRoblox };
}

async function captureHelpAsync(): Promise<string> {
	const spies = setupOutputSpies();
	setupDefaults();

	await runAsync(["--help"]);

	return String(spies.consoleLog.mock.calls[0]?.[0]);
}

const HELP_WRAP_REGEX = /\n {20,}/g;

/**
 * One help entry, unwrapped onto a single line. The help text folds a long
 * description onto indented continuation lines, so a trailing note reads the
 * same whichever line it landed on.
 *
 * @param help - The full help text.
 * @param flag - The flag that starts the entry.
 * @returns The unwrapped entry line.
 */
function helpEntry(help: string, flag: string): string {
	const entries = help.replaceAll(HELP_WRAP_REGEX, " ").split("\n");

	return String(entries.find((line) => line.trimStart().startsWith(`${flag} `)));
}

function renderedStderr(spies: OutputSpies): string {
	return stripVTControlCharacters(
		spies.stderr.mock.calls.map(([chunk]) => String(chunk)).join(""),
	);
}

describe(runAsync, () => {
	it("should settle the active progress stage when execution throws", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		const cli = setupDefaults();
		cli.runJestRoblox.mockImplementation(({ progress }) => {
			assert(progress !== undefined);
			progress.reveal({ color: false });
			progress.begin("boot", "version 88");
			throw new Error("boot failed");
		});

		const code = await runAsync([], cli.dependencies);

		expect(code).toBe(2);
		expect(spies.stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
			" · boot probe   version 88\n",
		);
	});

	it("should return 2 and print banner for ConfigError", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		const cli = setupDefaults();
		cli.loadConfig.mockRejectedValue(new ConfigError("bad value", "try this instead"));

		const code = await runAsync([], cli.dependencies);

		expect(code).toBe(2);
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("Config Error"));
	});

	it("should return 3 and report a stalled task as an infrastructure failure", async () => {
		expect.assertions(3);

		const spies = setupOutputSpies();
		const cli = setupDefaults();
		cli.runJestRoblox.mockRejectedValue(
			new TaskStallError({
				error: new Error("The task stalled"),
				evidence: {
					createTime: "2026-09-23T10:00:00.000Z",
					kind: "task-stall",
					observedStates: ["QUEUED"],
					placeVersion: 42,
					task: "universes/1/places/2/versions/42/luau-execution-sessions/s/tasks/t",
					timeoutSeconds: 300,
					updateTime: "2026-09-23T10:05:00.000Z",
				},
				readResultAsync: async () => ({ durationMs: 0, outputs: [] }),
			}),
		);

		const code = await runAsync([], cli.dependencies);

		expect(code).toBe(3);
		expect(renderedStderr(spies)).toContain("Roblox Infrastructure Error");
		expect(renderedStderr(spies)).toContain("The task stalled");
	});
});

describe(main, () => {
	it("should pass only user arguments and set process.exitCode from the run result", async () => {
		expect.assertions(2);

		const cli = setupDefaults();
		setupOutputSpies();

		const originalArgv = process.argv;
		const originalExitCode = process.exitCode;
		process.argv = ["node", "jest-roblox", "--parallel", "2"];

		onTestFinished(() => {
			process.argv = originalArgv;
			process.exitCode = originalExitCode;
		});

		await main(cli.dependencies);

		expect(process.exitCode).toBe(0);
		expect(cli.runJestRoblox).toHaveBeenCalledWith(
			expect.objectContaining<Record<string, unknown>>({
				cli: expect.objectContaining({ files: undefined, parallel: 2 }),
				config: expect.any(Object),
				fileSystem: cli.fileSystem,
				progress: expect.any(Object),
			}),
		);
	});
});

describe("runInner orchestration", () => {
	it("should write the run log through the injected file system", async () => {
		expect.assertions(1);

		setupOutputSpies();
		const cli = setupDefaults();

		await runAsync([], cli.dependencies);

		expect(
			cli.fileSystem.existsSync(path.join("/test", ".jest-roblox", "last-run.log")),
		).toBeTrue();
	});

	it("should move the run log under the root the run resolved", async () => {
		expect.assertions(1);

		setupOutputSpies();
		const cli = setupDefaults();
		cli.runJestRoblox.mockResolvedValue(
			makeWorkspaceResult({
				output: {
					collectCoverage: false,
					color: false,
					formatters: ["default"],
					perUnitGameOutput: false,
					perUnitOutputFile: false,
					rootDir: "/workspace",
					showLuau: false,
					silent: false,
					verbose: false,
				},
			}),
		);

		await runAsync([], cli.dependencies);

		expect(
			cli.fileSystem.existsSync(path.join("/workspace", ".jest-roblox", "last-run.log")),
		).toBeTrue();
	});

	it("should print the help and return 0 when --help is passed", async () => {
		expect.assertions(3);

		const spies = setupOutputSpies();
		const cli = setupDefaults();

		const code = await runAsync(["--help"], cli.dependencies);

		expect(code).toBe(0);
		expect(spies.consoleLog).toHaveBeenCalledWith(
			expect.stringContaining("Usage: jest-roblox"),
		);
		expect(cli.loadConfig).not.toHaveBeenCalled();
	});

	it.for([
		"--collectCoverageFrom",
		"--coverageReporters",
		"--formatters",
		"--project",
		"--setupFiles",
		"--setupFilesAfterEnv",
	])("should mark %s as a repeatable flag, not a variadic one", async (flag) => {
		expect.assertions(1);

		const entry = helpEntry(await captureHelpAsync(), flag);

		expect(entry).toContain("(repeatable)");
	});

	it.for([
		"--timeout",
		"--color",
		"--showLuau",
		"--hiddenDesktop",
		"--coverage-cache",
		"--upload-cache",
	])("should document %s", async (flag) => {
		expect.assertions(1);

		const help = await captureHelpAsync();

		expect(help).toMatch(new RegExp(`^ {2}${flag}(?![\\w-])`, "m"));
	});

	it("should document no binary-input option", async () => {
		expect.assertions(1);

		const help = await captureHelpAsync();

		expect(help).not.toContain("binary-input");
	});

	it("should document no option value as variadic", async () => {
		expect.assertions(1);

		// parseArgs collects a repeated flag; it never takes several values
		// after one flag. A `<name...>` entry invited `--project a b`, which
		// silently turned `b` into a positional file filter.
		const help = await captureHelpAsync();

		expect(help).not.toMatch(/<[^>]*\.\.\.>/);
	});

	it("should print VERSION and return 0 when --version is passed", async () => {
		expect.assertions(3);

		const spies = setupOutputSpies();
		const cli = setupDefaults();

		const code = await runAsync(["--version"], cli.dependencies);

		expect(code).toBe(0);
		expect(spies.consoleLog).toHaveBeenCalledExactlyOnceWith(packageJson.version);
		expect(cli.loadConfig).not.toHaveBeenCalled();
	});

	it("should load config for --typecheck in SEA mode", async () => {
		expect.assertions(1);

		setupOutputSpies();
		const cli = setupDefaults();

		vi.stubEnv("JEST_ROBLOX_SEA", "true");

		await runAsync(["--typecheck", "--formatters", "default"], cli.dependencies);

		expect(cli.loadConfig).toHaveBeenCalledOnce();
	});

	it("should allow typechecking outside SEA mode", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		const cli = setupDefaults();
		vi.stubEnv("JEST_ROBLOX_SEA", "false");

		const code = await runAsync(["--typecheck", "--formatters", "default"], cli.dependencies);

		expect(code).toBe(0);
		expect(spies.stderr).not.toHaveBeenCalled();
	});

	it("should allow runtime tests in SEA mode", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		const cli = setupDefaults();
		vi.stubEnv("JEST_ROBLOX_SEA", "true");

		const code = await runAsync(["--formatters", "default"], cli.dependencies);

		expect(code).toBe(0);
		expect(spies.stderr).not.toHaveBeenCalled();
	});

	it("should call loadConfig with --config path", async () => {
		expect.assertions(1);

		setupOutputSpies();
		const cli = setupDefaults();

		await runAsync(["--config", "./custom.ts"], cli.dependencies);

		expect(cli.loadConfig).toHaveBeenCalledWith({
			configPath: "./custom.ts",
			cwd: undefined,
			fileSystem: cli.fileSystem,
		});
	});

	it("should load the bootstrap config from --workspace-root", async () => {
		expect.assertions(1);

		setupOutputSpies();
		const cli = setupDefaults();

		await runAsync(
			["--workspace", "--packages", "foo", "--workspace-root", "/ws"],
			cli.dependencies,
		);

		expect(cli.loadConfig).toHaveBeenCalledWith({
			configPath: undefined,
			cwd: "/ws",
			fileSystem: cli.fileSystem,
		});
	});

	it("should pass cli flags into runJestRoblox", async () => {
		expect.assertions(1);

		setupOutputSpies();
		const cli = setupDefaults();

		await runAsync(["--verbose"], cli.dependencies);

		expect(cli.runJestRoblox).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining<Record<string, unknown>>({
				cli: expect.objectContaining({ verbose: true }),
				config: expect.anything(),
				fileSystem: cli.fileSystem,
				progress: expect.anything(),
			}),
		);
	});

	it("should propagate a non-zero exit code from outputRun", async () => {
		expect.assertions(1);

		setupOutputSpies();
		const cli = setupDefaults();
		cli.outputRun.mockResolvedValue(1);

		const code = await runAsync([], cli.dependencies);

		expect(code).toBe(1);
	});

	it("should dispatch a multi result to outputRun", async () => {
		expect.assertions(2);

		setupOutputSpies();
		const cli = setupDefaults();
		const multi = makeMultiResult();
		cli.runJestRoblox.mockResolvedValue(multi);

		const code = await runAsync([], cli.dependencies);

		expect(code).toBe(0);
		expect(cli.outputRun).toHaveBeenCalledWith(
			expect.objectContaining({
				dependencies: { fileSystem: cli.fileSystem },
				result: multi,
			}),
		);
	});

	it("should dispatch a workspace result to outputRun", async () => {
		expect.assertions(2);

		setupOutputSpies();
		const cli = setupDefaults();
		const workspace = makeWorkspaceResult();
		cli.runJestRoblox.mockResolvedValue(workspace);

		const code = await runAsync([], cli.dependencies);

		expect(code).toBe(0);
		expect(cli.outputRun).toHaveBeenCalledWith(
			expect.objectContaining({
				dependencies: { fileSystem: cli.fileSystem },
				result: workspace,
			}),
		);
	});

	it("should print the notice of a passing empty partial run", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		const cli = setupDefaults();
		cli.runJestRoblox.mockResolvedValue(
			makeMultiResult({
				output: undefined,
				projectResults: [],
				validationMessage: "No test files reach the related files, exiting with code 0\n",
			}),
		);
		const code = await runAsync(["related", "src/unused.luau"], cli.dependencies);

		expect(code).toBe(0);
		expect(renderedStderr(spies)).toContain(
			"No test files reach the related files, exiting with code 0",
		);
	});

	it("should write validationMessage to stderr and return validationExitCode", async () => {
		expect.assertions(3);

		const spies = setupOutputSpies();
		const cli = setupDefaults();
		cli.runJestRoblox.mockResolvedValue(
			makeWorkspaceResult({
				projectResults: [],
				validationExitCode: 2,
				validationMessage: "Error: --packages names no packages.\n",
			}),
		);

		const code = await runAsync(["--workspace"], cli.dependencies);

		expect(code).toBe(2);
		expect(spies.stderr).toHaveBeenCalledWith("Error: --packages names no packages.\n");
		expect(cli.outputRun).not.toHaveBeenCalled();
	});

	it("should not write to stderr when validationMessage is undefined", async () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		const cli = setupDefaults();
		cli.runJestRoblox.mockResolvedValue(
			makeMultiResult({ projectResults: [], validationExitCode: 2 }),
		);

		const code = await runAsync(["--formatters", "default"], cli.dependencies);

		expect(code).toBe(2);
		expect(spies.stderr).not.toHaveBeenCalled();
	});

	it("should return 0 for workspace with empty projectResults (no validation error)", async () => {
		expect.assertions(2);

		setupOutputSpies();
		const cli = setupDefaults();
		cli.runJestRoblox.mockResolvedValue(
			makeWorkspaceResult({ output: undefined, projectResults: [] }),
		);

		const code = await runAsync(["--workspace", "--affected-since", "main"], cli.dependencies);

		expect(code).toBe(0);
		expect(cli.outputRun).not.toHaveBeenCalled();
	});

	it("should return 0 for multi mode with empty projects and no typecheck", async () => {
		expect.assertions(2);

		setupOutputSpies();
		const cli = setupDefaults();
		cli.runJestRoblox.mockResolvedValue(
			makeMultiResult({ output: undefined, projectResults: [] }),
		);

		const code = await runAsync([], cli.dependencies);

		expect(code).toBe(0);
		expect(cli.outputRun).not.toHaveBeenCalled();
	});

	it("should dispatch multi mode with empty projects but typecheck present", async () => {
		expect.assertions(2);

		setupOutputSpies();
		const cli = setupDefaults();
		const result = makeMultiResult({ projectResults: [], typecheckResult: makeJestResult() });
		cli.runJestRoblox.mockResolvedValue(result);

		const code = await runAsync([], cli.dependencies);

		expect(code).toBe(0);
		expect(cli.outputRun).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				dependencies: { fileSystem: cli.fileSystem },
				result,
			}),
		);
	});

	it("should let --no-coverage override config that enables coverage", async () => {
		expect.assertions(1);

		setupOutputSpies();
		const cli = setupDefaults({ collectCoverage: true });

		await runAsync(["--no-coverage"], cli.dependencies);

		const [{ config }] = cli.runJestRoblox.mock.calls[0]!;

		expect(config.collectCoverage).toBeFalse();
	});

	it("should pass explicit --formatters through merge into config", async () => {
		expect.assertions(1);

		setupOutputSpies();
		const cli = setupDefaults();

		await runAsync(["--formatters", "json"], cli.dependencies);

		const [{ config }] = cli.runJestRoblox.mock.calls[0]!;

		expect(config.formatters).toStrictEqual(["json"]);
	});

	it("should fall back to the default formatters when nothing names one", async () => {
		expect.assertions(1);

		setupOutputSpies();
		const cli = setupDefaults();

		await runAsync([], cli.dependencies);

		const [{ config }] = cli.runJestRoblox.mock.calls[0]!;

		expect(config.formatters).toStrictEqual(expectedDefaultFormatters());
	});

	it("should default formatters to github-actions when GITHUB_ACTIONS env is true", async () => {
		expect.assertions(1);

		setupOutputSpies();
		const cli = setupDefaults();

		vi.stubEnv("GITHUB_ACTIONS", "true");

		await runAsync([], cli.dependencies);

		const [{ config }] = cli.runJestRoblox.mock.calls[0]!;

		expect(config.formatters).toContain("github-actions");
	});
});

describe("setup subcommand", () => {
	it("should run setup instead of a test run when setup is the first positional", async () => {
		expect.assertions(4);

		const spies = setupOutputSpies();
		const { fileSystem, volume } = createMemoryFileSystem();
		volume.mkdirSync(process.cwd(), { recursive: true });
		const cli = setupDefaults();
		const homeDirectory = path.resolve("/home/user");

		const code = await runAsync(["setup"], { ...cli.dependencies, fileSystem, homeDirectory });

		expect(code).toBe(0);
		expect(
			volume.existsSync(
				path.join(
					homeDirectory,
					".jest-roblox",
					"typedefs",
					packageJson.version,
					"config.luau",
				),
			),
		).toBeTrue();
		expect(cli.loadConfig).not.toHaveBeenCalled();
		expect(spies.stdout).toHaveBeenCalledWith(
			expect.stringContaining('Created .config.luau with the "jest-roblox" alias'),
		);
	});

	it("should show a .luaurc that setup cannot read as a Config Error with the entry to add", async () => {
		expect.assertions(3);

		const spies = setupOutputSpies();
		const { fileSystem } = createMemoryFileSystem({
			[path.join(process.cwd(), ".luaurc")]: '{ "aliases": { "x": 1 } }',
		});
		const cli = setupDefaults();

		const code = await runAsync(["setup"], {
			...cli.dependencies,
			fileSystem,
			homeDirectory: path.resolve("/home/user"),
		});

		expect(code).toBe(2);
		expect(renderedStderr(spies)).toContain(
			"Failed to read .luaurc: aliases.x must be a string (was a number)",
		);
		expect(renderedStderr(spies)).toContain(
			`Hint: Fix the file and run setup again, or add this entry to its "aliases" by hand: "jest-roblox": "~/.jest-roblox/typedefs/${packageJson.version}"`,
		);
	});

	it("should run tests filtered to setup when the filter is written ./setup", async () => {
		expect.assertions(1);

		setupOutputSpies();
		const cli = setupDefaults();

		await runAsync(["./setup"], cli.dependencies);

		const [{ cli: options }] = cli.runJestRoblox.mock.calls[0]!;

		expect(options.files).toStrictEqual(["./setup"]);
	});
});

describe("alias version warning", () => {
	it("should warn about an alias for another version and keep the run's exit code", async () => {
		expect.assertions(3);

		const spies = setupOutputSpies();
		const cli = setupDefaults();
		cli.outputRun.mockResolvedValue(1);
		const { fileSystem } = createMemoryFileSystem({
			"/test/default.project.json": "{}",
			[path.join(process.cwd(), ".luaurc")]:
				'{ "aliases": { "jest-roblox": "~/.jest-roblox/typedefs/0.0.1" } }',
		});

		const code = await runAsync([], { ...cli.dependencies, fileSystem });

		expect(code).toBe(1);
		expect(cli.runJestRoblox).toHaveBeenCalledOnce();
		expect(renderedStderr(spies)).toContain(
			`Warning: the "jest-roblox" alias in .luaurc points at the Luau Config type for jest-roblox 0.0.1, but this is jest-roblox ${packageJson.version}. Run \`jest-roblox setup\` to update it.\n`,
		);
	});
});
