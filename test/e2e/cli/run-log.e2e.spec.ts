import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { runLogPath } from "../../../src/run-log/run-log.ts";
import { startFakeOpenCloudServerAsync } from "./fake-open-cloud.ts";
import {
	buildPassingJestOutput,
	createFixtureSandbox,
	createOpenCloudEnvironment,
	rojoOnPath,
	runCliAsync,
} from "./helpers.ts";

const LUAU_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/luau-project");
const RUN_TIMEOUT_MS = 60_000;

describe("run log", () => {
	it.skipIf(!rojoOnPath())(
		"should keep the run's output on disk and tell the agent formatter where",
		async () => {
			expect.assertions(3);

			const sandbox = createFixtureSandbox(LUAU_FIXTURE_PATH);
			const server = await startFakeOpenCloudServerAsync([
				{ jestOutput: buildPassingJestOutput() },
			]);

			const result = await runCliAsync(["--backend", "open-cloud", "--formatters", "agent"], {
				cwd: sandbox,
				env: createOpenCloudEnvironment(server.baseUrl),
				timeoutMs: RUN_TIMEOUT_MS,
			});
			const logPath = runLogPath(sandbox);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(fs.readFileSync(logPath, "utf8"), "the log holds the output").toContain(
				"1 passed",
			);
			expect(result.stderr, "the agent formatter is told where").toContain(logPath);
		},
		RUN_TIMEOUT_MS * 2,
	);
});
