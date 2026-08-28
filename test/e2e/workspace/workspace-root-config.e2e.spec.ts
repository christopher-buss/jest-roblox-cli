import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServerAsync } from "../cli/fake-open-cloud.ts";
import {
	buildPassingJestOutput,
	createFixtureSandbox,
	createOpenCloudEnvironment,
	rojoOnPath,
	runCliAsync,
} from "../cli/helpers.ts";

// A workspace run resolves per-package configs; the file at the invocation
// directory is bootstrap only, read for `workspace.root` / `workspace.packages`
// and nothing else. Every other workspace e2e runs against a fixture root that
// holds no config at all, which is exactly why a config leaking into the report,
// the print layer, or the exit code was invisible here for so long.
//
// This spec runs the same command twice in the SAME sandbox — once bare, then
// again with a hostile root config beside the packages — and pins that the run
// is indistinguishable. Reusing one sandbox keeps the workspace root, and every
// path printed relative to it, byte-identical between the two runs.

const WORKSPACE_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/workspace");
const RUN_TIMEOUT_MS = 60_000;

// Every field here differs from what the packages resolve, and each one used to
// reach the run: the globs match no file under `packages/`, so the report
// universe filtered to empty; the reporters, directory, and sink decided which
// files landed on disk; `silent` and `formatters` decided what printed; and the
// threshold gated packages that declared none, so it moved the exit code.
const HOSTILE_ROOT_CONFIG = [
	"export default {",
	'\tformatters: ["json"],',
	'\toutputFile: "hostile-output.json",',
	"\ttest: {",
	"\t\tcollectCoverage: true,",
	'\t\tcollectCoverageFrom: ["src/server/**/ecs/**"],',
	'\t\tcoverageDirectory: "hostile-coverage",',
	'\t\tcoverageReporters: ["cobertura"],',
	"\t\tcoverageThreshold: { statements: 99 },",
	"\t\tsilent: true,",
	"\t},",
	"};",
	"",
].join("\n");

// `--no-upload-cache` keeps the two runs comparable: the second would
// otherwise reuse the place the first uploaded, reporting a cache hit and
// skipping the Boot Probe. That is run order, not anything the config changed.
const CLI_ARGUMENTS = [
	"--workspace",
	"--packages=@e2e/nested",
	"--coverage",
	"--backend",
	"open-cloud",
	"--no-upload-cache",
];

interface RunSnapshot {
	exitCode: number;
	files: Array<string>;
	stderr: string;
	stdout: string;
}

/**
 * Every file under the sandbox, sandbox-relative and sorted. The root config
 * itself is dropped so the two listings differ only by what the RUN wrote.
 */
function listFiles(sandbox: string): Array<string> {
	const found: Array<string> = [];
	const entries = fs.readdirSync(sandbox, { recursive: true, withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) {
			continue;
		}

		const absolute = path.join(entry.parentPath, entry.name);
		found.push(path.relative(sandbox, absolute).replaceAll("\\", "/"));
	}

	return found.filter((file) => file !== "jest.config.ts").sort();
}

/**
 * Blank the parts of a run that legitimately vary between two invocations — the
 * wall clock, elapsed times, the ephemeral port the fake Open Cloud server
 * bound, and the pid and import cache-buster Node stamps onto its own warnings.
 * What survives is everything the config could have changed.
 */
function normalizeOutput(text: string): string {
	return text
		.replaceAll(/\d{2}:\d{2}:\d{2}/g, "<clock>")
		.replaceAll(/\d+(?:\.\d+)?\s?(?:ms|s)\b/g, "<time>")
		.replaceAll(/127\.0\.0\.1:\d+/g, "<host>")
		.replaceAll(/\(node:\d+\)/g, "(node:<pid>)")
		.replaceAll(/\.ts\?_\d+/g, ".ts?_<n>");
}

async function runWorkspaceAsync(sandbox: string): Promise<RunSnapshot> {
	const server = await startFakeOpenCloudServerAsync([
		{ jestOutput: buildPassingJestOutput(), pkg: "@e2e/nested", project: "@e2e/nested" },
	]);

	const result = await runCliAsync(CLI_ARGUMENTS, {
		cwd: sandbox,
		env: createOpenCloudEnvironment(server.baseUrl),
		timeoutMs: RUN_TIMEOUT_MS,
	});

	return {
		exitCode: result.exitCode,
		files: listFiles(sandbox),
		stderr: normalizeOutput(result.stderr),
		stdout: normalizeOutput(result.stdout),
	};
}

describe("workspace run vs a config at the invocation directory", () => {
	it.skipIf(!rojoOnPath())(
		"should produce the same output, files, and exit code with a hostile root config",
		async () => {
			expect.assertions(5);

			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);

			const bare = await runWorkspaceAsync(sandbox);

			expect(bare.exitCode, `stderr: ${bare.stderr}\nstdout: ${bare.stdout}`).toBe(0);

			fs.writeFileSync(path.join(sandbox, "jest.config.ts"), HOSTILE_ROOT_CONFIG);
			const hostile = await runWorkspaceAsync(sandbox);

			expect(hostile.stdout).toBe(bare.stdout);
			// `collectCoverage: true` at the root used to open the pooled
			// coverage path, whose first act on a run with no pooled data is a
			// warning on stderr.
			expect(hostile.stderr).toBe(bare.stderr);
			expect(hostile.files).toStrictEqual(bare.files);
			expect(hostile.exitCode).toBe(bare.exitCode);
		},
		RUN_TIMEOUT_MS * 2 + 5000,
	);
});
