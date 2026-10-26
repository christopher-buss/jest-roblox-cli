import { loadConfig, runJestRobloxAsync } from "@isentinel/jest-roblox/artifacts";

import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

const ROJO_TREE = {
	$className: "DataModel",
	ReplicatedStorage: {
		$className: "ReplicatedStorage",
		B: { $path: "src/b" },
	},
};

function createProject(files: Record<string, string>): string {
	const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "luau-config-")));
	onTestFinished(() => {
		fs.rmSync(directory, { force: true, recursive: true });
	});
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

	it("should stop with the file and line of a top-level value it cannot read", async () => {
		expect.assertions(1);

		const directory = createProject({
			"jest.config.luau": 'return {\n\tplaceFile = os.getenv("PLACE"),\n}\n',
		});

		await expect(loadConfig({ cwd: directory })).rejects.toThrow(
			`Luau config ${path.join(directory, "jest.config.luau")}:2 holds a function call`,
		);
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
			mode: "multi",
			validationExitCode: 2,
			validationMessage: "No test files found in any project\n",
		});
	});

	it("should stop with the file and line of a project value it cannot read", async () => {
		expect.assertions(1);

		const directory = createProject({
			"default.project.json": JSON.stringify({ name: "config-integration", tree: ROJO_TREE }),
			"jest.config.luau": 'return { test = { projects = { "src/b" } } }\n',
			"src/b/jest.config.luau":
				'return {\n\tdisplayName = "b",\n\ttestTimeout = 5 * 1000,\n}\n',
		});

		const config = await loadConfig({ cwd: directory });

		await expect(runJestRobloxAsync({ cli: { typecheckOnly: true }, config })).rejects.toThrow(
			`Luau config ${path.join(directory, "src/b/jest.config.luau")}:3 holds an operator`,
		);
	});
});
