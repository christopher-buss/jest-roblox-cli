import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";

import { initGitRepo } from "#test/e2e/cli/git-repo.ts";
import type { PartialRunResult } from "#test/e2e/cli/partial-run.ts";
import {
	PARTIAL_RUN_TIMEOUT_MS as RUN_TIMEOUT_MS,
	runPartialAsync,
} from "#test/e2e/cli/partial-run.ts";
import { createFixtureSandbox, rojoOnPath } from "#test/harness/helpers.ts";

const RELATED_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/related-project");

interface WideningCase {
	changes: Record<string, string>;
	description: string;
	file: string;
}

const WIDENING_CASES: Array<WideningCase> = [
	{ changes: {}, description: "an Opaque Change in the project root", file: "jest.config.luau" },
	{
		changes: {
			"src/middle.luau":
				'local name = "leaf"\nlocal _ = require(script.Parent:FindFirstChild(name))\nreturn require("./leaf")\n',
		},
		description: "a dynamic require in the graph",
		file: "src/unused.luau",
	},
	{
		changes: {
			"src/middle.luau": 'local _ = require("./nowhere")\nreturn require("./leaf")\n',
		},
		description: "an unresolved string require in the graph",
		file: "src/unused.luau",
	},
	{
		changes: { "../pnpm-lock.yaml": "" },
		description: "a lockfile in the workspace root",
		file: "../pnpm-lock.yaml",
	},
	{
		changes: {
			"../tools/build.ts": "",
			"jest.config.luau":
				'return {\n\tforceRerunTriggers = { "tools/**" },\n\tplaceFile = "game.rbxl",\n\ttest = {},\n}\n',
		},
		description: "a configured forceRerunTriggers glob",
		file: "../tools/build.ts",
	},
];

function createGitWorkspace(): string {
	const project = createFixtureSandbox(RELATED_FIXTURE_PATH);
	const repo = initGitRepo(path.dirname(project));
	repo.write("pnpm-workspace.yaml", "packages:\n  - related-project\n");
	repo.commit("fixture");
	return project;
}

function writeChanges(project: string, changes: Record<string, string>): void {
	for (const [file, content] of Object.entries(changes)) {
		const target = path.join(project, file);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
}

async function runRelatedAsync(
	files: Array<string>,
	changes: Record<string, string> = {},
): Promise<PartialRunResult> {
	const sandbox = createGitWorkspace();
	writeChanges(sandbox, changes);
	return runPartialAsync(sandbox, ["related", ...files]);
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

	it.for(WIDENING_CASES)(
		"should dispatch every spec for $description",
		{ timeout: RUN_TIMEOUT_MS * 2 },
		async ({ changes, file }) => {
			expect.assertions(3);

			const run = await runRelatedAsync([file], changes);

			expect(run.exitCode, `stderr: ${run.stderr}\nstdout: ${run.stdout}`).toBe(0);
			expect(run.patterns).toStrictEqual([
				expect.stringMatching(/other\\\.spec.*top\\\.spec/),
			]);
			expect(stripVTControlCharacters(run.stdout)).toContain(
				"   Affected  2 of 2 test files",
			);
		},
	);

	it(
		"should ignore a change outside the project root, the Rojo tree and the triggers",
		async () => {
			expect.assertions(3);

			const run = await runRelatedAsync(["../docs/notes.md"], { "../docs/notes.md": "" });

			expect(run.exitCode, `stderr: ${run.stderr}\nstdout: ${run.stdout}`).toBe(0);
			expect(run.patterns).toStrictEqual([]);
			expect(run.stderr).toContain(
				"No test files reach the related files, exiting with code 0",
			);
		},
		RUN_TIMEOUT_MS * 2,
	);
});
