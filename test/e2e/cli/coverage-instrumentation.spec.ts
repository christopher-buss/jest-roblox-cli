import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { assert, describe, expect, it } from "vitest";

import { startFakeOpenCloudServerAsync } from "#test/harness/fake-open-cloud.ts";
import {
	buildPassingJestOutput,
	createFixtureSandbox,
	createOpenCloudEnvironment,
	rojoOnPath,
	RUN_TIMEOUT_MS,
	runCliAsync,
} from "#test/harness/helpers.ts";

const LUAU_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/luau-project");
const COVERAGE_FIXTURES_PATH = path.resolve(__dirname, "../../fixtures/coverage-pipeline");

const BRANCH_COUNTS = '__b[1][1] .. "," .. __b[1][2] .. "," .. __b[2][1] .. "," .. __b[2][2]';
const KEPT_ARMS =
	'#__b[1] .. ":" .. __b[1][1] .. "," .. #__b[2] .. ":" .. __b[2][1] .. "," .. __b[2][2]';

function readTwin(sandbox: string, name: string): string {
	const match = fs
		.readdirSync(sandbox, { recursive: true, withFileTypes: true })
		.find((entry) => {
			return (
				entry.isFile() &&
				entry.name === name &&
				path.relative(sandbox, entry.parentPath).includes("coverage")
			);
		});
	assert(match !== undefined, `no instrumented ${name} under ${sandbox}`);
	return fs.readFileSync(path.join(match.parentPath, match.name), "utf-8");
}

function withBranchPrint(twin: string, expression: string): string {
	const fileKey = /__cov_file_key = "([^"]+)"/u.exec(twin)![1]!;
	return `${twin}
local __b = _G.__jest_roblox_cov["${fileKey}"].b
print(${expression})
`;
}

function runLute(source: string, directory: string): Array<string> {
	const scriptPath = path.join(directory, "lute-run.luau");
	fs.writeFileSync(scriptPath, `local _G = {}\n${source}`);
	return execFileSync("lute", ["run", scriptPath], {
		encoding: "utf-8",
		timeout: 10_000,
		windowsHide: true,
	})
		.trim()
		.split(/\r?\n/u);
}

async function instrumentThroughCliAsync(): Promise<string> {
	const sandbox = createFixtureSandbox(LUAU_FIXTURE_PATH);
	fs.cpSync(COVERAGE_FIXTURES_PATH, path.join(sandbox, "src"), { recursive: true });
	const server = await startFakeOpenCloudServerAsync([{ jestOutput: buildPassingJestOutput() }]);

	const result = await runCliAsync(["--coverage", "--backend", "open-cloud"], {
		cwd: sandbox,
		env: createOpenCloudEnvironment(server.baseUrl),
		timeoutMs: RUN_TIMEOUT_MS,
	});
	assert(result.exitCode === 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);

	return sandbox;
}

describe.skipIf(!rojoOnPath())("coverage instrumentation through the CLI", () => {
	it(
		"should write instrumented twins that lute runs with branch counts intact",
		async () => {
			expect.assertions(4);

			const sandbox = await instrumentThroughCliAsync();
			const runs = fs.readdirSync(COVERAGE_FIXTURES_PATH).map((name) => {
				return runLute(readTwin(sandbox, name), sandbox);
			});

			expect(runs).toHaveLength(fs.readdirSync(COVERAGE_FIXTURES_PATH).length);
			expect(
				runLute(
					withBranchPrint(readTwin(sandbox, "and-or-short-circuit.luau"), BRANCH_COUNTS),
					sandbox,
				),
			).toStrictEqual(["L1,L2", "false", "true", "1,0,1,0"]);
			expect(
				runLute(
					withBranchPrint(readTwin(sandbox, "and-or-rhs-eval.luau"), BRANCH_COUNTS),
					sandbox,
				),
			).toStrictEqual(["L1,R1,L2,R2", "42", "99", "1,1,1,1"]);
			expect(
				runLute(
					withBranchPrint(readTwin(sandbox, "ignore-directives.luau"), KEPT_ARMS),
					sandbox,
				),
			).toStrictEqual(["big", "2", "1:1,2:1,0"]);
		},
		RUN_TIMEOUT_MS + 5000,
	);
});
