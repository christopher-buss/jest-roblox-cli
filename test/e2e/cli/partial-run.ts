import { type } from "arktype";

import { startFakeOpenCloudServerAsync } from "#test/e2e/cli/fake-open-cloud.ts";
import {
	buildPassingJestOutput,
	createOpenCloudEnvironment,
	runCliAsync,
} from "#test/e2e/cli/helpers.ts";

/** A CLI run on the fake Open Cloud backend, and the scripts it dispatched. */
export interface PartialRunResult {
	exitCode: number;
	/** Each dispatched `testPathPattern`, decoded. */
	patterns: Array<string>;
	/** Every dispatched script, joined. */
	scripts: string;
	stderr: string;
	stdout: string;
}

export const PARTIAL_RUN_TIMEOUT_MS = 60_000;

const TEST_PATH_PATTERN = /"testPathPattern":("(?:[^"\\]|\\.)*")/g;
const jsonString = type("string.json.parse").to("string");

/**
 * Run the CLI in `cwd` on a fake Open Cloud backend whose one task passes,
 * and read back what it dispatched.
 *
 * @param cwd - Sandbox to run in.
 * @param args - CLI arguments after the backend flag.
 * @returns The exit code, streams, and dispatched scripts and patterns.
 */
export async function runPartialAsync(cwd: string, args: Array<string>): Promise<PartialRunResult> {
	const server = await startFakeOpenCloudServerAsync([{ jestOutput: buildPassingJestOutput() }]);

	const result = await runCliAsync(["--backend", "open-cloud", ...args], {
		cwd,
		env: { ...createOpenCloudEnvironment(server.baseUrl), TIMING: "1" },
		timeoutMs: PARTIAL_RUN_TIMEOUT_MS,
	});

	const scripts = server.requests.map((request) => request.script).join("\n");
	return {
		exitCode: result.exitCode,
		patterns: Array.from(scripts.matchAll(TEST_PATH_PATTERN), ([, literal]) => {
			return jsonString.assert(literal);
		}),
		scripts,
		stderr: result.stderr,
		stdout: result.stdout,
	};
}
