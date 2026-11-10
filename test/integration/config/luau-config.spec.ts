import { loadConfig, runJestRobloxAsync } from "@isentinel/jest-roblox/api";

import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createLuteChildProcess } from "#test/mocks/lute-child-process.ts";
import packageJson from "../../../package.json" with { type: "json" };

const ROJO_TREE = {
	$className: "DataModel",
	ReplicatedStorage: {
		$className: "ReplicatedStorage",
		B: { $path: "src/b" },
	},
};

function createTemporaryDirectory(prefix: string): string {
	const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	onTestFinished(() => {
		fs.rmSync(directory, { force: true, recursive: true });
	});
	return directory;
}

function createProject(files: Record<string, string>): string {
	const home = createTemporaryDirectory("luau-config-home-");
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	const directory = createTemporaryDirectory("luau-config-");
	for (const [relativePath, source] of Object.entries(files)) {
		const filePath = path.join(directory, relativePath);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, source);
	}

	return directory;
}

describe("luau configs through loadConfig", () => {
	it("should clear default ignore patterns with an empty luau table", async () => {
		expect.assertions(2);

		const directory = createProject({
			"jest.config.luau":
				"do end\nreturn { test = { testPathIgnorePatterns = {}, snapshotFormat = {} } }",
		});
		const config = await loadConfig({ cwd: directory });

		expect(config.testPathIgnorePatterns).toStrictEqual([]);
		expect(config.snapshotFormat).toStrictEqual({});
	});

	it("should name both configs before evaluating a conflicting script", async () => {
		expect.assertions(1);

		const directory = createProject({
			"jest.config.luau": "return {}",
			"jest.config.mjs": 'throw new Error("must not run");',
		});

		await expect(loadConfig({ cwd: directory })).rejects.toThrow(
			`Found two jest configs: ${path.join(directory, "jest.config.mjs")} and ${path.join(directory, "jest.config.luau")}. Keep one.`,
		);
	});

	it.for(["42", '"config"', "true", "nil"])(
		"should name a config returning %s instead of a table",
		async (value) => {
			expect.assertions(1);

			const directory = createProject({ "jest.config.luau": `return ${value}` });

			await expect(loadConfig({ cwd: directory })).rejects.toThrow(
				`Luau config ${path.join(directory, "jest.config.luau")} must return a table`,
			);
		},
	);

	it("should read a typed plain-data top-level config without running it", async () => {
		expect.assertions(3);

		vi.stubEnv("PATH", "");
		vi.stubEnv("JEST_ROBLOX_LUTE_PATH", undefined);
		const directory = createProject({
			"jest.config.luau": [
				'local jest = require("@jest-roblox/config")',
				"",
				"return jest.defineConfig({",
				'\tplaceFile = "luau.rbxl" :: string,',
				'\trootDir = ".",',
				"\ttest = {",
				'\t\ttestMatch = { "**/*.spec" },',
				"\t},",
				"}) :: jest.Config",
				"",
			].join("\n"),
		});

		const config = await loadConfig({ cwd: directory });

		expect(config.placeFile).toBe("luau.rbxl");
		expect(config.rootDir).toBe(directory);
		expect(config.testMatch).toStrictEqual(["**/*.spec"]);
	});

	it("should run a config that requires a sibling module with lute", async () => {
		expect.assertions(2);

		const directory = createProject({
			"jest.config.luau": [
				'local shared = require("./shared")',
				"",
				"return {",
				"\tplaceFile = shared.placeFile,",
				"\ttest = { testMatch = shared.testMatch, testTimeout = 5 * 1000, setupFiles = {} },",
				"}",
				"",
			].join("\n"),
			"shared.luau": 'return { placeFile = "shared.rbxl", testMatch = { "**/*.test" } }\n',
		});

		const config = await loadConfig({ cwd: directory });

		expect(config).toMatchObject({
			placeFile: "shared.rbxl",
			setupFiles: [],
			testMatch: ["**/*.test"],
			testTimeout: 5000,
		});
		expect(config.rootDir).toBe(directory);
	});

	it.for([
		["yes", "ci.rbxl"],
		["", "local.rbxl"],
	] as const)("should load the branch for JEST_ROBLOX_BRANCH=%j", async ([value, placeFile]) => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_BRANCH", value);
		const directory = createProject({
			"jest.config.luau": [
				'local process = require("@std/process")',
				"",
				"return function()",
				"\tlocal branch = process.env.JEST_ROBLOX_BRANCH",
				'\treturn { placeFile = if branch and branch ~= "" then "ci.rbxl" else "local.rbxl" }',
				"end",
				"",
			].join("\n"),
		});

		const config = await loadConfig({ cwd: directory });

		expect(config.placeFile).toBe(placeFile);
	});

	it("should write the config type before lute runs a config that requires it", async () => {
		expect.assertions(2);

		const directory = createProject({
			".luaurc": JSON.stringify({
				aliases: { "jest-roblox": `~/.jest-roblox/typedefs/${packageJson.version}` },
			}),
			"jest.config.luau": [
				'local jest = require("@jest-roblox/config")',
				"",
				"return jest.defineConfig({",
				"\ttest = { testTimeout = 5 * 1000 },",
				"})",
				"",
			].join("\n"),
		});

		const config = await loadConfig({ cwd: directory });

		expect(config.testTimeout).toBe(5000);
		expect(
			fs.existsSync(
				path.join(
					os.homedir(),
					".jest-roblox",
					"typedefs",
					packageJson.version,
					"config.luau",
				),
			),
		).toBeTrue();
	});

	it("should run a config that holds code through the given child process", async () => {
		expect.assertions(1);

		const directory = createProject({
			"jest.config.luau": 'return { placeFile = "place" .. ".rbxl" }\n',
		});

		const config = await loadConfig({
			childProcess: createLuteChildProcess({
				value: '{"placeFile":"from-child-process.rbxl"}',
				version: "1.0.1\n",
			}),
			cwd: directory,
		});

		expect(config.placeFile).toBe("from-child-process.rbxl");
	});

	it("should read a plain-data config when lute is absent", async () => {
		expect.assertions(1);

		vi.stubEnv("PATH", "");
		vi.stubEnv("JEST_ROBLOX_LUTE_PATH", undefined);
		const directory = createProject({
			"jest.config.luau": 'return { placeFile = "plain.rbxl" }',
		});

		const config = await loadConfig({ cwd: directory });

		expect(config.placeFile).toBe("plain.rbxl");
	});

	it("should say lute is needed and name the line when lute is absent", async () => {
		expect.assertions(1);

		vi.stubEnv("PATH", "");
		vi.stubEnv("JEST_ROBLOX_LUTE_PATH", undefined);
		const directory = createProject({
			"jest.config.luau": 'return {\n\tplaceFile = string.lower("A.rbxl"),\n}\n',
		});

		await expect(loadConfig({ cwd: directory })).rejects.toThrow(
			`Luau config ${path.join(directory, "jest.config.luau")}:2 holds a function call, which needs lute to run`,
		);
	});

	it.for([
		['return {\n\tplaceFile = os.getenv("PLACE"),\n}\n', "failed in lute: "],
		['return tonumber("5")\n', "must return a table, but it returned a number"],
		[
			"return { test = { setupFiles = { tostring } } }\n",
			"holds a function at test.setupFiles[1], which cannot cross into JSON",
		],
	] as const)("should name the file when lute cannot load %j", async ([source, message]) => {
		expect.assertions(1);

		const directory = createProject({ "jest.config.luau": source });

		await expect(loadConfig({ cwd: directory })).rejects.toThrow(
			`Luau config ${path.join(directory, "jest.config.luau")} ${message}`,
		);
	});

	it("should let a script config extend a luau config that holds code", async () => {
		expect.assertions(2);

		const directory = createProject({
			"base.luau": "return { timeout = 2 * 1000, test = { verbose = true } }\n",
			"jest.config.mjs":
				'export default { extends: "./base.luau", test: { verbose: false } };\n',
		});

		const config = await loadConfig({ cwd: directory });

		expect(config.timeout).toBe(2000);
		expect(config.verbose).toBeFalse();
	});

	it("should load a luau project config a luau top-level config names", async () => {
		expect.assertions(1);

		const directory = createProject({
			"default.project.json": JSON.stringify({ name: "config-integration", tree: ROJO_TREE }),
			"jest.config.luau": 'return { test = { projects = { "src/b" } } }\n',
			"src/b/jest.config.luau": [
				"return {",
				'\tdisplayName = "b-user",',
				'\ttestMatch = { "**/*.spec" },',
				"}",
				"",
			].join("\n"),
		});

		const config = await loadConfig({ cwd: directory });
		const result = await runJestRobloxAsync({
			cli: { project: ["b-user"], typecheckOnly: true },
			config,
		});

		expect(result).toMatchObject({
			validationExitCode: 2,
			validationMessage: "No test files found in any project\n",
		});
	});

	it("should run a luau project config that holds code with lute", async () => {
		expect.assertions(1);

		const directory = createProject({
			"default.project.json": JSON.stringify({ name: "config-integration", tree: ROJO_TREE }),
			"jest.config.luau": 'return { test = { projects = { "src/b" } } }\n',
			"src/b/jest.config.luau": [
				'local shared = require("./shared")',
				"",
				"return {",
				'\tdisplayName = "b-" .. shared.suffix,',
				"\ttestTimeout = 5 * 1000,",
				"}",
				"",
			].join("\n"),
			"src/b/shared.luau": 'return { suffix = "user" }\n',
		});

		const config = await loadConfig({ cwd: directory });
		const result = await runJestRobloxAsync({
			cli: { project: ["b-user"], typecheckOnly: true },
			config,
		});

		expect(result).toMatchObject({
			validationExitCode: 2,
			validationMessage: "No test files found in any project\n",
		});
	});
});
