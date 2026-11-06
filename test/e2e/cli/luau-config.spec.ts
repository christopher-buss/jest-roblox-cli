import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServerAsync } from "#test/e2e/cli/fake-open-cloud.ts";
import {
	buildPassingJestOutput,
	createFixtureSandbox,
	createOpenCloudEnvironment,
	rojoOnPath,
	runCliAsync,
	runSeaExecutableAsync,
} from "#test/e2e/cli/helpers.ts";
import { nodeAt, readPlaceTree } from "#test/e2e/cli/place-tree.ts";

const LUAU_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/luau-project");
const WORKSPACE_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/workspace");
const RUN_TIMEOUT_MS = 60_000;

const NO_OPEN_CLOUD_CREDENTIALS = {
	JEST_ROBLOX_OPEN_CLOUD_API_KEY: undefined,
	JEST_ROBLOX_PLACE_ID: undefined,
	JEST_ROBLOX_UNIVERSE_ID: undefined,
	ROBLOX_OPEN_CLOUD_API_KEY: undefined,
	ROBLOX_PLACE_ID: undefined,
	ROBLOX_UNIVERSE_ID: undefined,
} as const satisfies Record<string, string | undefined>;

const MISSING_ALL_BUT_PLACE_ID = "Missing: apiKey, universeId.";

async function runSeaOnFakeOpenCloudAsync(
	sandbox: string,
): ReturnType<typeof runSeaExecutableAsync> {
	const server = await startFakeOpenCloudServerAsync([{ jestOutput: buildPassingJestOutput() }]);

	return runSeaExecutableAsync(["--backend", "open-cloud"], {
		cwd: sandbox,
		env: createOpenCloudEnvironment(server.baseUrl),
		timeoutMs: RUN_TIMEOUT_MS,
	});
}

describe("luau configs", () => {
	it.skipIf(!rojoOnPath())(
		"should run to completion on a jest.config.luau under the sea executable",
		async () => {
			expect.assertions(2);

			const sandbox = createFixtureSandbox(LUAU_FIXTURE_PATH);
			fs.writeFileSync(
				path.join(sandbox, "jest.config.luau"),
				'local jest = require("@jest-roblox/config")\n\nreturn jest.defineConfig({\n\toutputFile = "luau-result.json",\n\ttest = {},\n}) :: jest.Config\n',
			);
			const result = await runSeaOnFakeOpenCloudAsync(sandbox);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(
				fs.existsSync(path.join(sandbox, "luau-result.json")),
				"the outputFile the luau config names",
			).toBeTrue();
		},
		RUN_TIMEOUT_MS * 2,
	);

	it.skipIf(!rojoOnPath())(
		"should run a jest.config.luau that holds code with lute under the sea executable",
		async () => {
			expect.assertions(2);

			const sandbox = createFixtureSandbox(LUAU_FIXTURE_PATH);
			fs.writeFileSync(
				path.join(sandbox, "jest.shared.luau"),
				'return { outputFile = "lute-result.json" }\n',
			);
			fs.writeFileSync(
				path.join(sandbox, "jest.config.luau"),
				'local shared = require("./jest.shared")\n\nreturn {\n\toutputFile = shared.outputFile,\n\ttest = {},\n}\n',
			);
			const result = await runSeaOnFakeOpenCloudAsync(sandbox);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(
				fs.existsSync(path.join(sandbox, "lute-result.json")),
				"the outputFile the required module names",
			).toBeTrue();
		},
		RUN_TIMEOUT_MS * 2,
	);

	it.skipIf(!rojoOnPath())(
		"should stage a stub without cli keys for a jest.config.luau that is also the top-level config",
		async () => {
			expect.assertions(6);

			const sandbox = createFixtureSandbox(LUAU_FIXTURE_PATH);
			fs.rmSync(path.join(sandbox, "jest.config.luau"));
			const configPath = path.join(sandbox, "src/jest.config.luau");
			const config = [
				"return {",
				'\tbackend = "open-cloud",',
				'\tplaceFile = "game.rbxlx",',
				'\trootDir = "..",',
				"\ttest = {",
				"\t\ttestTimeout = 4321,",
				"\t},",
				"}",
				"",
			].join("\n");
			fs.writeFileSync(configPath, config);
			const server = await startFakeOpenCloudServerAsync([
				{ jestOutput: buildPassingJestOutput() },
			]);

			const result = await runCliAsync(["--config", "src/jest.config.luau"], {
				cwd: sandbox,
				env: createOpenCloudEnvironment(server.baseUrl),
				timeoutMs: RUN_TIMEOUT_MS,
			});

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(fs.readFileSync(configPath, "utf8")).toBe(config);

			const stub = fs.readFileSync(
				path.join(sandbox, ".jest-roblox/cache/src/jest.config.luau"),
				"utf8",
			);

			expect(stub).toContain("\ttestTimeout = 4321,\n");
			expect(stub).not.toMatch(/backend|placeFile|rootDir/);

			const placeFile = path.join(sandbox, "game.rbxlx");
			const mount = nodeAt(readPlaceTree(placeFile), ["ReplicatedStorage", "src"]);

			expect(mount.children.filter((node) => node.name === "jest.config")).toHaveLength(1);
			expect(fs.readFileSync(placeFile, "utf8")).not.toContain('backend = "open-cloud"');
		},
		RUN_TIMEOUT_MS + 5000,
	);

	it("should load the luau file that --config names", async () => {
		expect.assertions(2);

		const sandbox = createFixtureSandbox(LUAU_FIXTURE_PATH);
		fs.mkdirSync(path.join(sandbox, "configs"));
		fs.writeFileSync(
			path.join(sandbox, "configs/ci.luau"),
			'return { placeId = "123", rootDir = "..", test = {} }\n',
		);

		const result = await runCliAsync(
			["--config", "configs/ci.luau", "--backend", "open-cloud"],
			{
				cwd: sandbox,
				env: NO_OPEN_CLOUD_CREDENTIALS,
			},
		);

		expect(result.exitCode).toBeGreaterThan(0);
		expect(result.stderr).toContain(MISSING_ALL_BUT_PLACE_ID);
	});

	it("should name the file when lute cannot evaluate a jest.config.luau", async () => {
		expect.assertions(2);

		const sandbox = createFixtureSandbox(LUAU_FIXTURE_PATH);
		const configPath = path.join(sandbox, "jest.config.luau");
		fs.writeFileSync(configPath, 'return {\n\tplaceId = os.getenv("PLACE_ID"),\n}\n');

		const result = await runCliAsync(["--backend", "open-cloud"], {
			cwd: sandbox,
			env: NO_OPEN_CLOUD_CREDENTIALS,
		});

		expect(result.exitCode).toBeGreaterThan(0);
		expect(result.stderr).toContain(`Luau config ${configPath} failed in lute: `);
	});

	it("should load a workspace package's jest.config.luau", async () => {
		expect.assertions(2);

		const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);
		const packageDirectory = path.join(sandbox, "packages/foo");
		fs.rmSync(path.join(packageDirectory, "jest.config.ts"));
		fs.writeFileSync(
			path.join(packageDirectory, "jest.config.luau"),
			[
				"return {",
				'\tplaceId = "123",',
				'\trojoProject = "test.project.json",',
				"\ttest = {",
				"\t\tpassWithNoTests = true,",
				'\t\ttestPathIgnorePatterns = { "foo\\\\.spec\\\\.luau$" },',
				"\t},",
				"}",
				"",
			].join("\n"),
		);

		const result = await runCliAsync(
			["--workspace", "--packages=@e2e/foo", "--backend", "open-cloud"],
			{ cwd: sandbox, env: NO_OPEN_CLOUD_CREDENTIALS },
		);

		expect(result.exitCode).toBeGreaterThan(0);
		expect(result.stderr).toContain(MISSING_ALL_BUT_PLACE_ID);
	});
});
