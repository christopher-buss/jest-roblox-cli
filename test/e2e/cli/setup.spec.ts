import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished } from "vitest";

import { runCliAsync } from "#test/e2e/cli/helpers.ts";
import { createSandboxDirectory } from "#test/e2e/sandbox-root.ts";
import packageJson from "../../../package.json" with { type: "json" };

const [CHECKER, CHECK] = ["lute", "check"] as const;
const ALIAS_LINE = `["jest-roblox"] = "~/.jest-roblox/typedefs/${packageJson.version}"`;

function createSetupSandbox(files: Record<string, string> = {}) {
	const root = createSandboxDirectory();
	onTestFinished(() => {
		fs.rmSync(root, { force: true, recursive: true });
	});
	const home = path.join(root, "home");
	const project = path.join(root, "project");
	fs.mkdirSync(home);
	fs.mkdirSync(project);
	for (const [name, contents] of Object.entries(files)) {
		fs.writeFileSync(path.join(project, name), contents);
	}

	const environment = { HOME: home, USERPROFILE: home };
	return {
		environment,
		home,
		project,
		read: (name: string) => fs.readFileSync(path.join(project, name), "utf-8"),
		runSetupAsync: async () => runCliAsync(["setup"], { cwd: project, env: environment }),
	};
}

async function checkWithLuteAsync({
	cwd,
	environment,
	file,
}: {
	cwd: string;
	environment: Record<string, string>;
	file: string;
}): Promise<string> {
	return new Promise((resolve) => {
		execFile(
			CHECKER,
			[CHECK, file],
			{ cwd, encoding: "utf-8", env: { ...process.env, ...environment }, windowsHide: true },
			(error, stdout, stderr) => {
				resolve(
					error === null
						? ""
						: `${error.message}
${stdout}${stderr}`,
				);
			},
		);
	});
}

describe("jest-roblox setup", () => {
	it("should write the type module and create .config.luau when neither file exists", async () => {
		expect.assertions(3);

		const sandbox = createSetupSandbox();

		const result = await sandbox.runSetupAsync();

		expect(result.exitCode).toBe(0);
		expect(
			fs.readFileSync(
				path.join(
					sandbox.home,
					".jest-roblox",
					"typedefs",
					packageJson.version,
					"config.luau",
				),
				"utf-8",
			),
		).toContain("export type Config");
		expect(sandbox.read(".config.luau")).toBe(
			`return {\n\tluau = {\n\t\taliases = {\n\t\t\t${ALIAS_LINE},\n\t\t},\n\t},\n}\n`,
		);
	});

	it("should add the alias to an existing .config.luau and keep its comments", async () => {
		expect.assertions(2);

		const sandbox = createSetupSandbox({
			".config.luau":
				'-- project settings\nreturn {\n\tluau = {\n\t\tlanguagemode = "strict", -- everywhere\n\t\taliases = {\n\t\t\tshared = "./shared",\n\t\t},\n\t},\n}\n',
		});

		const result = await sandbox.runSetupAsync();

		expect(result.exitCode).toBe(0);
		expect(sandbox.read(".config.luau")).toBe(
			`-- project settings\nreturn {\n\tluau = {\n\t\tlanguagemode = "strict", -- everywhere\n\t\taliases = {\n\t\t\tshared = "./shared",\n\t\t\t${ALIAS_LINE},\n\t\t},\n\t},\n}\n`,
		);
	});

	it("should merge the alias into a lone .luaurc and create no .config.luau", async () => {
		expect.assertions(3);

		const sandbox = createSetupSandbox({
			".luaurc": '{\n\t"languageMode": "strict",\n\t"aliases": { "shared": "./shared" }\n}\n',
		});

		const result = await sandbox.runSetupAsync();

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(sandbox.read(".luaurc"))).toStrictEqual({
			aliases: {
				"jest-roblox": `~/.jest-roblox/typedefs/${packageJson.version}`,
				"shared": "./shared",
			},
			languageMode: "strict",
		});
		expect(fs.existsSync(path.join(sandbox.project, ".config.luau"))).toBeFalse();
	});

	it("should leave a .luaurc with a trailing comma unchanged and name the entry to add", async () => {
		expect.assertions(3);

		const source = '{\n\t"languageMode": "strict",\n}\n';
		const sandbox = createSetupSandbox({ ".luaurc": source });

		const result = await sandbox.runSetupAsync();

		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(
			`"jest-roblox": "~/.jest-roblox/typedefs/${packageJson.version}"`,
		);
		expect(sandbox.read(".luaurc")).toBe(source);
	});

	it("should print the alias entry and succeed when luau.aliases is built by code", async () => {
		expect.assertions(3);

		const source = "local aliases = {}\nreturn { luau = { aliases = aliases } }\n";
		const sandbox = createSetupSandbox({ ".config.luau": source });

		const result = await sandbox.runSetupAsync();

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(`\t${ALIAS_LINE},\n`);
		expect(sandbox.read(".config.luau")).toBe(source);
	});

	it("should warn on a run when the alias names another version and keep the exit code", async () => {
		expect.assertions(3);

		const plain = createSetupSandbox();
		const stale = createSetupSandbox({
			".luaurc": '{ "aliases": { "jest-roblox": "~/.jest-roblox/typedefs/0.0.1" } }',
		});

		const [plainResult, staleResult] = await Promise.all(
			[plain, stale].map(async ({ environment, project }) => {
				return runCliAsync(["--backend", "open-cloud"], { cwd: project, env: environment });
			}),
		);

		expect(staleResult!.exitCode).toBe(plainResult!.exitCode);
		expect(plainResult!.stderr).not.toContain("jest-roblox setup");
		expect(staleResult!.stderr).toContain(
			`Warning: the "jest-roblox" alias in .luaurc points at the Luau Config type for jest-roblox 0.0.1, but this is jest-roblox ${packageJson.version}. Run \`jest-roblox setup\` to update it.`,
		);
	});

	it("should let lute check resolve the config type through the alias", async () => {
		expect.assertions(2);

		const sandbox = createSetupSandbox({
			"jest.config.luau":
				'local jest = require("@jest-roblox/config")\n\nreturn jest.defineConfig({\n\ttest = { verbose = true },\n})\n',
		});

		const result = await sandbox.runSetupAsync();

		expect(result.exitCode).toBe(0);
		await expect(
			checkWithLuteAsync({
				cwd: sandbox.project,
				environment: sandbox.environment,
				file: "jest.config.luau",
			}),
		).resolves.toBe("");
	});
});
