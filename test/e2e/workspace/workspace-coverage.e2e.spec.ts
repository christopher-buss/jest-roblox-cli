import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServer } from "../cli/fake-open-cloud.ts";
import { createFixtureSandbox, readJsonSync, runCliAsync } from "../cli/helpers.ts";

// Regression: HAL-211 — `--workspace --coverage` against a package whose rojo
// `$path` mounts a directory holding BOTH `*.spec.luau` and non-spec helpers
// (e.g. `out-test/src/init.luau` next to `out-test/src/nested.spec.luau`).
// Pre-fix, `containsLuauFiles` made the dir a coverage root via the helper,
// the synthesizer redirected `$path` to the shadow, and the instrumenter
// filtered specs out — the shadow held only the instrumented helper and
// testMatch returned zero matches.
//
// All prior workspace e2e tests run without `--coverage`, and the only
// coverage e2e (`project-pipeline.e2e.spec.ts`) is `JEST_ROBLOX_LIVE`-gated.
// HAL-211 lived squarely in the intersection of those missing axes.

const WORKSPACE_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/workspace");
const RUN_TIMEOUT_MS = 60_000;

function rojoOnPath(): boolean {
	try {
		cp.execFileSync("rojo", ["--version"], { stdio: "pipe", windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

function luteOnPath(): boolean {
	try {
		cp.execFileSync("lute", ["--version"], { stdio: "pipe", windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

describe("workspace coverage — $path mounts specs alongside helpers", () => {
	it.skipIf(!rojoOnPath() || !luteOnPath())(
		"should preserve spec files in the shadow and reach backend dispatch",
		async () => {
			expect.assertions(4);

			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);

			const server = await startFakeOpenCloudServer([
				{
					jestOutput: passingJestOutput(),
					pkg: "@e2e/nested",
					project: "@e2e/nested",
				},
			]);

			const result = await runCliAsync(
				["--workspace", "--packages=@e2e/nested", "--coverage", "--backend", "open-cloud"],
				{
					cwd: sandbox,
					env: {
						JEST_ROBLOX_OPEN_CLOUD_BASE_URL: server.baseUrl,
						ROBLOX_OPEN_CLOUD_API_KEY: "test-api-key",
						ROBLOX_PLACE_ID: "456",
						ROBLOX_UNIVERSE_ID: "123",
					},
					timeoutMs: RUN_TIMEOUT_MS,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);

			// Direct evidence the fix is in place: the cpSync into the shadow
			// dir copied the spec through. Pre-fix the shadow held only the
			// instrumented helper (`init.luau`), no `.spec.luau`.
			const shadowSpecPath = path.join(
				sandbox,
				".jest-roblox/workspace/@e2e-nested/coverage/out-test/src/nested.spec.luau",
			);

			expect(fs.existsSync(shadowSpecPath)).toBeTrue();

			// Guard against silent short-circuits — `passWithNoTests` on the
			// nested fixture would let zero-discovery pass even with the bug,
			// so we pin that the place was actually built and dispatched.
			expect(server.uploadCount).toBe(1);
			expect(server.requests).toHaveLength(1);
		},
		RUN_TIMEOUT_MS + 5000,
	);
});

function passingJestOutput(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: 0,
		success: true,
		testResults: [],
		...overrides,
	});
}

// Regression: HAL-215 — `--workspace --coverage` against a package whose rojo
// `test.project.json` mounts multiple `$path` entries (e.g. `src/` PLUS a
// vendored `Packages/` dir). Pre-fix, `discoverPackageLuauRoots` walked every
// `collectPaths` entry and instrumented every mounted directory — the per-pkg
// `luauRoots: ["src"]` was honored only in single mode, not workspace mode.
// The per-pkg `coveragePathIgnorePatterns` was likewise ignored because
// `prepareWorkspaceCoverage` read the matcher from the workspace-root config,
// never the merged pkgConfig.
//
// Both regression cases below assert on the shape of the per-package shadow
// directory after a CLI run: the user's source root must be instrumented; the
// vendored mount must not appear under the shadow.

describe("workspace coverage — multi-$path rojo tree honors per-pkg luauRoots", () => {
	it.skipIf(!rojoOnPath() || !luteOnPath())(
		"should instrument only the luauRoot-listed mounts, skipping vendored $path dirs",
		async () => {
			expect.assertions(5);

			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);

			const server = await startFakeOpenCloudServer([
				{
					jestOutput: passingJestOutput(),
					pkg: "@e2e/vendored-mount",
					project: "@e2e/vendored-mount",
				},
			]);

			const result = await runCliAsync(
				[
					"--workspace",
					"--packages=@e2e/vendored-mount",
					"--coverage",
					"--backend",
					"open-cloud",
				],
				{
					cwd: sandbox,
					env: {
						JEST_ROBLOX_OPEN_CLOUD_BASE_URL: server.baseUrl,
						ROBLOX_OPEN_CLOUD_API_KEY: "test-api-key",
						ROBLOX_PLACE_ID: "456",
						ROBLOX_UNIVERSE_ID: "123",
					},
					timeoutMs: RUN_TIMEOUT_MS,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);

			const shadowRoot = path.join(
				sandbox,
				".jest-roblox/workspace/@e2e-vendored-mount/coverage",
			);

			expect(fs.existsSync(path.join(shadowRoot, "src/init.luau"))).toBeTrue();
			expect(fs.existsSync(path.join(shadowRoot, "vendored-packages"))).toBeFalse();

			const manifest = readJsonSync(path.join(shadowRoot, "manifest.json")) as {
				files: Record<string, unknown>;
			};

			expect(
				Object.keys(manifest.files).some((key) => key.includes("/vendored-packages/")),
			).toBeFalse();
			expect(server.uploadCount).toBe(1);
		},
		RUN_TIMEOUT_MS + 5000,
	);

	it.skipIf(!rojoOnPath() || !luteOnPath())(
		"should respect per-package coveragePathIgnorePatterns over workspace defaults",
		async () => {
			expect.assertions(5);

			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);

			// Swap the fixture's luauRoots config for a
			// coveragePathIgnorePatterns config so this case exercises the OTHER
			// half of the per-pkg config plumbing. Both paths (luauRoots
			// short-circuit vs. the matchesIgnored filter) flow through
			// `prepareWorkspaceCoverage` independently; a regression in either is
			// silent without coverage on both axes.
			const packageJestConfig = path.join(sandbox, "packages/vendored-mount/jest.config.ts");
			fs.writeFileSync(
				packageJestConfig,
				[
					"export default {",
					'\trojoProject: "test.project.json",',
					"\ttest: {",
					"\t\tpassWithNoTests: true,",
					'\t\tcoveragePathIgnorePatterns: ["**/vendored-packages/**"],',
					"\t\tprojects: [",
					"\t\t\t{",
					"\t\t\t\ttest: {",
					'\t\t\t\t\tdisplayName: "@e2e/vendored-mount",',
					'\t\t\t\t\tinclude: ["src/**/*.spec.luau"],',
					"\t\t\t\t},",
					"\t\t\t},",
					"\t\t],",
					"\t},",
					"};",
					"",
				].join("\n"),
			);

			const server = await startFakeOpenCloudServer([
				{
					jestOutput: passingJestOutput(),
					pkg: "@e2e/vendored-mount",
					project: "@e2e/vendored-mount",
				},
			]);

			const result = await runCliAsync(
				[
					"--workspace",
					"--packages=@e2e/vendored-mount",
					"--coverage",
					"--backend",
					"open-cloud",
				],
				{
					cwd: sandbox,
					env: {
						JEST_ROBLOX_OPEN_CLOUD_BASE_URL: server.baseUrl,
						ROBLOX_OPEN_CLOUD_API_KEY: "test-api-key",
						ROBLOX_PLACE_ID: "456",
						ROBLOX_UNIVERSE_ID: "123",
					},
					timeoutMs: RUN_TIMEOUT_MS,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);

			const shadowRoot = path.join(
				sandbox,
				".jest-roblox/workspace/@e2e-vendored-mount/coverage",
			);

			expect(fs.existsSync(path.join(shadowRoot, "src/init.luau"))).toBeTrue();
			expect(fs.existsSync(path.join(shadowRoot, "vendored-packages"))).toBeFalse();

			const manifest = readJsonSync(path.join(shadowRoot, "manifest.json")) as {
				files: Record<string, unknown>;
			};

			expect(
				Object.keys(manifest.files).some((key) => key.includes("/vendored-packages/")),
			).toBeFalse();
			expect(server.uploadCount).toBe(1);
		},
		RUN_TIMEOUT_MS + 5000,
	);
});
