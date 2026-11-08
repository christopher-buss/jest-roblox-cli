import { type } from "arktype";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServerAsync } from "#test/e2e/cli/fake-open-cloud.ts";
import {
	buildPassingJestOutput,
	createFixtureSandbox,
	createOpenCloudEnvironment,
	rojoOnPath,
	runCliAsync,
} from "#test/e2e/cli/helpers.ts";

const RELATED_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/related-project");
const RUN_TIMEOUT_MS = 60_000;
const TEST_PATH_PATTERN = /"testPathPattern":("(?:[^"\\]|\\.)*")/g;
const jsonString = type("string.json.parse").to("string");

async function runRelatedAsync(files: Array<string>): Promise<{
	exitCode: number;
	patterns: Array<string>;
	stderr: string;
	stdout: string;
}> {
	const sandbox = createFixtureSandbox(RELATED_FIXTURE_PATH);
	const server = await startFakeOpenCloudServerAsync([{ jestOutput: buildPassingJestOutput() }]);

	const result = await runCliAsync(["--backend", "open-cloud", "related", ...files], {
		cwd: sandbox,
		env: { ...createOpenCloudEnvironment(server.baseUrl), TIMING: "1" },
		timeoutMs: RUN_TIMEOUT_MS,
	});

	const scripts = server.requests.map((request) => request.script).join("\n");
	return {
		exitCode: result.exitCode,
		patterns: Array.from(scripts.matchAll(TEST_PATH_PATTERN), ([, literal]) => {
			return jsonString.assert(literal);
		}),
		stderr: result.stderr,
		stdout: result.stdout,
	};
}

describe.skipIf(!rojoOnPath())("related", () => {
	it(
		"should dispatch only the spec that reaches a module two string requires below it",
		async () => {
			expect.assertions(5);

			const run = await runRelatedAsync(["src/leaf.luau"]);

			expect(run.exitCode, `stderr: ${run.stderr}\nstdout: ${run.stdout}`).toBe(0);
			expect(run.patterns).toHaveLength(1);
			expect(run.patterns[0]!).toMatch(/^\(\S*top\\\.spec\)$/);
			expect(run.stderr).toContain("buildDependencyGraph");
			expect(stripVTControlCharacters(run.stdout)).toContain(
				"   Affected  1 of 2 test files (related to src/leaf.luau)",
			);
		},
		RUN_TIMEOUT_MS * 2,
	);

	it(
		"should dispatch a given spec file on its own",
		async () => {
			expect.assertions(3);

			const run = await runRelatedAsync(["src/other.spec.luau"]);

			expect(run.exitCode, `stderr: ${run.stderr}\nstdout: ${run.stdout}`).toBe(0);
			expect(run.patterns).toHaveLength(1);
			expect(run.patterns[0]!).toMatch(/^\(\S*other\\\.spec\)$/);
		},
		RUN_TIMEOUT_MS * 2,
	);

	it(
		"should pass and dispatch nothing when no spec reaches the given file",
		async () => {
			expect.assertions(3);

			const run = await runRelatedAsync(["src/unused.luau"]);

			expect(run.exitCode, `stderr: ${run.stderr}\nstdout: ${run.stdout}`).toBe(0);
			expect(run.patterns).toStrictEqual([]);
			expect(run.stderr).toContain(
				"No test files reach the related files, exiting with code 0",
			);
		},
		RUN_TIMEOUT_MS * 2,
	);
});
