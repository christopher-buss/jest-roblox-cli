import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServerAsync } from "#test/harness/fake-open-cloud.ts";
import {
	buildPassingJestOutput,
	createFixtureSandbox,
	createOpenCloudEnvironment,
	rojoOnPath,
	RUN_TIMEOUT_MS,
	runCliAsync,
} from "#test/harness/helpers.ts";

const FIXTURE = path.resolve(__dirname, "../fixtures/workspace");

describe.skipIf(!rojoOnPath())("workspace related summary", () => {
	it.for(["foo", "bar"])(
		"should print the workspace-relative path for %s with two packages",
		async (name) => {
			expect.assertions(2);

			const cwd = createFixtureSandbox(FIXTURE);
			const server = await startFakeOpenCloudServerAsync([
				{ jestOutput: buildPassingJestOutput() },
			]);
			const file = `packages/${name}/src/${name}.spec.luau`;
			const result = await runCliAsync(
				[
					"related",
					file,
					"--workspace",
					"--packages=@e2e/foo,@e2e/bar",
					"--backend",
					"open-cloud",
					"--no-coverage",
				],
				{ cwd, env: createOpenCloudEnvironment(server.baseUrl), timeoutMs: RUN_TIMEOUT_MS },
			);

			expect(result.exitCode).toBe(0);
			expect(stripVTControlCharacters(result.stdout)).toContain(
				`   Affected  1 of 2 test files (related to ${file})`,
			);
		},
	);
});
