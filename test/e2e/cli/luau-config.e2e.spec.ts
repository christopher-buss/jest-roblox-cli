import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServerAsync } from "./fake-open-cloud.ts";
import {
	buildPassingJestOutput,
	createFixtureSandbox,
	createOpenCloudEnvironment,
	rojoOnPath,
	runCliAsync,
	runSeaExecutableAsync,
} from "./helpers.ts";

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
			const server = await startFakeOpenCloudServerAsync([
				{ jestOutput: buildPassingJestOutput() },
			]);

			const result = await runSeaExecutableAsync(["--backend", "open-cloud"], {
				cwd: sandbox,
				env: createOpenCloudEnvironment(server.baseUrl),
				timeoutMs: RUN_TIMEOUT_MS,
			});

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(
				fs.existsSync(path.join(sandbox, "luau-result.json")),
				"the outputFile the luau config names",
			).toBeTrue();
		},
		RUN_TIMEOUT_MS * 2,
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

	it("should name the file and line of syntax a jest.config.luau cannot hold", async () => {
		expect.assertions(2);

		const sandbox = createFixtureSandbox(LUAU_FIXTURE_PATH);
		const configPath = path.join(sandbox, "jest.config.luau");
		fs.writeFileSync(configPath, 'return {\n\tplaceId = os.getenv("PLACE_ID"),\n}\n');

		const result = await runCliAsync(["--backend", "open-cloud"], {
			cwd: sandbox,
			env: NO_OPEN_CLOUD_CREDENTIALS,
		});

		expect(result.exitCode).toBeGreaterThan(0);
		expect(result.stderr).toContain(`${configPath}:2 holds a function call`);
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
