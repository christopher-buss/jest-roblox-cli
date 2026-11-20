import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "vitest";

import { startFakeOpenCloudServerAsync } from "#test/helpers/integration/fake-open-cloud.ts";
import {
	createFixtureSandbox,
	createOpenCloudEnvironment,
	rojoOnPath,
	RUN_TIMEOUT_MS,
	runSeaBundleAsync,
} from "#test/helpers/integration/helpers.ts";

// Regression (jest-roblox-cli#6): `istanbul-reports` loads reporters with
// `require(path.join(__dirname, 'lib', name))`, which the standalone binary
// cannot resolve, so every `--coverage` run died before its report. These
// specs drive the bundle, the only place a reporter must be bundled.

const LUAU_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/luau-project");

/**
 * A passing run whose envelope carries hit counts for the fixture's one source
 * file, which is what makes the CLI reach the report step at all: a run with no
 * coverage data warns and returns before any reporter is created.
 * @returns Serialized envelope.
 */
function buildCoverageOutput(): string {
	return JSON.stringify({
		runner: {
			coverage: { "src/example.luau": { s: { "0": 1 } } },
			setup: 0.1,
		},
		success: true,
		value: {
			numFailedTests: 0,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: 0,
			success: true,
			testResults: [],
		},
	});
}

async function runCoverageAsync(
	reporters: Array<string>,
): Promise<{ result: { exitCode: number; stderr: string; stdout: string }; sandbox: string }> {
	const sandbox = createFixtureSandbox(LUAU_FIXTURE_PATH);
	const server = await startFakeOpenCloudServerAsync([{ jestOutput: buildCoverageOutput() }]);

	const reporterArguments = reporters.flatMap((name) => ["--coverageReporters", name]);
	const result = await runSeaBundleAsync(
		["--coverage", ...reporterArguments, "--backend", "open-cloud"],
		{
			cwd: sandbox,
			env: createOpenCloudEnvironment(server.baseUrl),
			timeoutMs: RUN_TIMEOUT_MS,
		},
	);

	return { result, sandbox };
}

describe("sea bundle coverage reporters", () => {
	it.skipIf(!rojoOnPath())(
		"should render the text table and write a summary the bundle carries no reporter file for",
		async ({ expect }) => {
			expect.assertions(3);

			const { result, sandbox } = await runCoverageAsync(["text", "json-summary"]);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(result.stdout).toContain("% Coverage report from istanbul");
			expect(fs.existsSync(path.join(sandbox, "coverage/coverage-summary.json"))).toBeTrue();
		},
		RUN_TIMEOUT_MS + 5000,
	);

	it.skipIf(!rojoOnPath())(
		"should write the default lcov report with the html assets it copies off disk",
		async ({ expect }) => {
			expect.assertions(4);

			// `lcov` is half of the default reporter set and builds an
			// `HtmlReport` of its own, which copies css/js/png assets from
			// `<istanbul-reports>/lib/html/assets` at report time. Those files
			// are no more present beside the binary than the reporter modules
			// are, so the default run needs them carried too.
			const { result, sandbox } = await runCoverageAsync(["text", "lcov"]);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(fs.existsSync(path.join(sandbox, "coverage/lcov.info"))).toBeTrue();
			expect(fs.existsSync(path.join(sandbox, "coverage/lcov-report/index.html"))).toBeTrue();
			expect(fs.existsSync(path.join(sandbox, "coverage/lcov-report/base.css"))).toBeTrue();
		},
		RUN_TIMEOUT_MS + 5000,
	);
});
