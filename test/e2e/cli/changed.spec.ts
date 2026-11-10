import { type } from "arktype";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";

import type { GitRepo } from "#test/e2e/cli/git-repo.ts";
import { initGitRepo } from "#test/e2e/cli/git-repo.ts";
import {
	PARTIAL_RUN_TIMEOUT_MS as RUN_TIMEOUT_MS,
	runPartialAsync,
} from "#test/e2e/cli/partial-run.ts";
import { startFakeOpenCloudServerAsync } from "#test/harness/fake-open-cloud.ts";
import {
	createFixtureSandbox,
	createOpenCloudEnvironment,
	rojoOnPath,
	runCliAsync,
} from "#test/harness/helpers.ts";

const RELATED_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/related-project");
const SETUP_FILES = /"setupFiles":(\[[^\]]*\])/g;
const jsonStrings = type("string.json.parse").to("string[]");

const CONFIG_WITH_SETUP = [
	"return {",
	'\tplaceFile = "game.rbxl",',
	'\ttest = { setupFiles = { "./src/setup.luau" } },',
	"}",
	"",
].join("\n");

const CONFIG_WITH_THRESHOLD = [
	"return {",
	'\tplaceFile = "game.rbxl",',
	"\ttest = { coverageThreshold = { statements = 100 } },",
	"}",
	"",
].join("\n");

interface ChangedRun {
	exitCode: number;
	patterns: Array<string>;
	setupFiles: Array<Array<string>>;
	stderr: string;
	stdout: string;
}

async function runChangedAsync(sandbox: string, args: Array<string>): Promise<ChangedRun> {
	const run = await runPartialAsync(sandbox, args);
	return {
		...run,
		setupFiles: Array.from(run.scripts.matchAll(SETUP_FILES), ([, literal]) => {
			return jsonStrings.assert(literal);
		}),
		stdout: stripVTControlCharacters(run.stdout),
	};
}

async function runWithLeafHitsAsync(
	sandbox: string,
	{ args, leafHits }: { args: Array<string>; leafHits: number },
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
	const jestOutput = JSON.stringify({
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		runner: { coverage: { "src/leaf.luau": { s: [leafHits] } } },
		startTime: 0,
		success: true,
		testResults: [],
	});
	const server = await startFakeOpenCloudServerAsync([{ jestOutput }]);
	const result = await runCliAsync(["--backend", "open-cloud", "--coverage", ...args], {
		cwd: sandbox,
		env: createOpenCloudEnvironment(server.baseUrl),
		timeoutMs: RUN_TIMEOUT_MS,
	});
	return { ...result, stdout: stripVTControlCharacters(result.stdout) };
}

function createChangedRepo(config: string): GitRepo & { sandbox: string } {
	const sandbox = createFixtureSandbox(RELATED_FIXTURE_PATH);
	writeFileSync(path.join(sandbox, "jest.config.luau"), config);
	writeFileSync(path.join(sandbox, "src/setup.luau"), "return nil\n");
	writeFileSync(path.join(sandbox, ".gitignore"), "game.rbxl\n.jest-roblox/\ncoverage/\n");
	const repo = initGitRepo(sandbox);
	repo.commit("base");
	return { ...repo, sandbox };
}

describe.skipIf(!rojoOnPath())("--changed", () => {
	it(
		"should dispatch the specs that reach a staged or untracked change, with their setup files",
		async () => {
			expect.assertions(7);

			const repo = createChangedRepo(CONFIG_WITH_SETUP);
			repo.write("src/leaf.luau", "return {\n\tvalue = 2,\n}\n");
			repo.git("add", "src/leaf.luau");
			repo.write("src/fresh.spec.luau", "return function() end\n");

			const run = await runChangedAsync(repo.sandbox, ["--changed"]);

			expect(run.exitCode, `stderr: ${run.stderr}\nstdout: ${run.stdout}`).toBe(0);
			expect(run.patterns).toHaveLength(1);
			expect(run.patterns[0]!).toMatch(/top\\\.spec/);
			expect(run.patterns[0]!).toMatch(/fresh\\\.spec/);
			expect(run.patterns[0]!).not.toMatch(/other\\\.spec/);
			expect(run.setupFiles[0]!).toStrictEqual([expect.stringMatching(/setup$/)]);
			expect(run.stdout).toContain("   Affected  2 of 3 test files (changed since HEAD)");
		},
		RUN_TIMEOUT_MS * 2,
	);

	it(
		"should dispatch every spec that required a deleted module",
		async () => {
			expect.assertions(3);

			const repo = createChangedRepo(CONFIG_WITH_SETUP);
			repo.remove("src/leaf.luau");

			const run = await runChangedAsync(repo.sandbox, ["--changed"]);

			expect(run.exitCode, `stderr: ${run.stderr}\nstdout: ${run.stdout}`).toBe(0);
			expect(run.patterns).toHaveLength(1);
			expect(run.patterns[0]!).toMatch(/^\(\S*top\\\.spec\)$/);
		},
		RUN_TIMEOUT_MS * 2,
	);

	it(
		"should dispatch the specs that reach a change committed since the ref",
		async () => {
			expect.assertions(3);

			const repo = createChangedRepo(CONFIG_WITH_SETUP);
			repo.git("branch", "base");
			repo.write("src/leaf.luau", "return {\n\tvalue = 2,\n}\n");
			repo.commit("change leaf");

			const run = await runChangedAsync(repo.sandbox, ["--changed", "base"]);

			expect(run.exitCode, `stderr: ${run.stderr}\nstdout: ${run.stdout}`).toBe(0);
			expect(run.patterns).toHaveLength(1);
			expect(run.patterns[0]!).toMatch(/^\(\S*top\\\.spec\)$/);
		},
		RUN_TIMEOUT_MS * 2,
	);

	it(
		"should report and gate coverage on the changed source files alone",
		async () => {
			expect.assertions(4);

			const repo = createChangedRepo(CONFIG_WITH_THRESHOLD);
			repo.write("src/leaf.luau", "return {\n\tvalue = 2,\n}\n");

			const run = await runWithLeafHitsAsync(repo.sandbox, {
				args: ["--changed"],
				leafHits: 1,
			});

			expect(run.exitCode, `stderr: ${run.stderr}\nstdout: ${run.stdout}`).toBe(0);
			expect(run.stdout).toMatch(/ leaf\.luau +\| +100 /);
			expect(run.stdout).not.toContain("middle.luau");
			expect(run.stdout).not.toContain("unused.luau");
		},
		RUN_TIMEOUT_MS * 2,
	);

	it(
		"should fail the threshold on a changed source file below it",
		async () => {
			expect.assertions(2);

			const repo = createChangedRepo(CONFIG_WITH_THRESHOLD);
			repo.write("src/leaf.luau", "return {\n\tvalue = 2,\n}\n");

			const run = await runWithLeafHitsAsync(repo.sandbox, {
				args: ["--changed"],
				leafHits: 0,
			});

			expect(run.exitCode, `stderr: ${run.stderr}\nstdout: ${run.stdout}`).toBe(1);
			expect(run.stderr).toContain("Coverage threshold not met for statements: 0.00% < 100%");
		},
		RUN_TIMEOUT_MS * 2,
	);

	it(
		"should gate every source file on a full run",
		async () => {
			expect.assertions(2);

			const repo = createChangedRepo(CONFIG_WITH_THRESHOLD);

			const run = await runWithLeafHitsAsync(repo.sandbox, { args: [], leafHits: 1 });

			expect(run.exitCode, `stderr: ${run.stderr}\nstdout: ${run.stdout}`).toBe(1);
			expect(run.stdout).toContain("unused.luau");
		},
		RUN_TIMEOUT_MS * 2,
	);

	it(
		"should pass and dispatch nothing when no spec reaches an uncommitted change",
		async () => {
			expect.assertions(3);

			const repo = createChangedRepo(CONFIG_WITH_SETUP);
			repo.write("src/unused.luau", "return { unused = true }\n");

			const run = await runChangedAsync(repo.sandbox, ["--changed"]);

			expect(run.exitCode, `stderr: ${run.stderr}\nstdout: ${run.stdout}`).toBe(0);
			expect(run.patterns).toStrictEqual([]);
			expect(run.stderr).toContain(
				"No test files reach the files changed since HEAD, exiting with code 0",
			);
		},
		RUN_TIMEOUT_MS * 2,
	);
});
