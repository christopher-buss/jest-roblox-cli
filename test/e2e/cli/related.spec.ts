import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";

import type { PartialRunResult } from "#test/e2e/cli/partial-run.ts";
import {
	PARTIAL_RUN_TIMEOUT_MS as RUN_TIMEOUT_MS,
	runPartialAsync,
} from "#test/e2e/cli/partial-run.ts";
import { createFixtureSandbox, rojoOnPath } from "#test/harness/helpers.ts";

const RELATED_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/related-project");

async function runRelatedAsync(files: Array<string>): Promise<PartialRunResult> {
	return runPartialAsync(createFixtureSandbox(RELATED_FIXTURE_PATH), ["related", ...files]);
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
