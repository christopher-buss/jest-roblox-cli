import { type } from "arktype";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServer } from "../cli/fake-open-cloud.ts";
import { createFixtureSandbox, runCliAsync } from "../cli/helpers.ts";

// Live single-project pipeline tests. Both gated on JEST_ROBLOX_LIVE=1 plus
// the three Open Cloud env vars (`ROBLOX_OPEN_CLOUD_API_KEY`,
// `ROBLOX_UNIVERSE_ID`, `ROBLOX_PLACE_ID`). When the gate is off these tests
// stay dormant — vitest reports them as skipped, the live wire is never
// touched, and the file can run on machines without secrets.
//
// The fixture (`test/e2e/fixtures/live-place`) ships a pre-built `.rbxl` plus
// two configured `projects` in its `jest.config.ts`. We restrict the run to
// `live-place-shared` (one passing spec) so the assertion can target
// "1 passed" deterministically, regardless of how the second mount evolves.

const LIVE_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/live-place");
const USER_AUTHORED_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/user-authored-config");
const RUN_TIMEOUT_MS = 120_000;

const isLive = process.env["JEST_ROBLOX_LIVE"] === "1";

function rojoOnPath(): boolean {
	try {
		cp.execFileSync("rojo", ["--version"], { stdio: "pipe", windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

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

const coverageEntrySchema = type({
	s: { "[string]": "number" },
});
const coverageReportSchema = type({
	"[string]": coverageEntrySchema,
});

const gameOutputEntrySchema = type({
	message: "string",
	messageType: "number",
	timestamp: "number",
});
// Multi-project runs write the grouped Aggregated Game Output shape:
// `[{ project, entries }]` (no package for a single-config run).
const gameOutputSchema = type({
	"entries": gameOutputEntrySchema.array(),
	"package?": "string",
	"project": "string",
}).array();

describe("live project pipeline", () => {
	it.runIf(isLive)(
		"should pass end-to-end against live Open Cloud",
		async () => {
			expect.assertions(7);

			const sandbox = createFixtureSandbox(LIVE_FIXTURE_PATH);
			const result = await runCliAsync(
				[
					"--backend",
					"open-cloud",
					"--config",
					"jest.config.ts",
					"--project",
					"live-place-shared",
				],
				{
					cwd: sandbox,
					env: liveEnvironment(),
					timeoutMs: RUN_TIMEOUT_MS,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(result.stdout).toContain("1 passed");

			// Refactor invariant: auto-stubs never land in source mount paths.
			// The cache stub at `.jest-roblox/cache/<mount>/jest.config.luau`
			// is canonical; the source-tree mount must stay clean.
			expect(fs.existsSync(path.join(sandbox, "out/shared/jest.config.luau"))).toBeFalse();
			expect(fs.existsSync(path.join(sandbox, "out/server/jest.config.luau"))).toBeFalse();
			expect(
				fs.existsSync(path.join(sandbox, ".jest-roblox/cache/out/shared/jest.config.luau")),
			).toBeTrue();

			// Regression (HAL --testPathPattern): a filesystem-namespace
			// `--testPathPattern` (with the `src/` prefix Jest-on-Roblox never
			// sees) must be normalized to an Instance-namespace basename before
			// forwarding, otherwise it matches zero files on the Luau side and
			// the run dies with `<exec-error>` "Test suite failed to run". This
			// is the only check that exercises the FS→Instance namespace fix
			// against the real Roblox-side Jest.
			const patternResult = await runCliAsync(
				[
					"--backend",
					"open-cloud",
					"--config",
					"jest.config.ts",
					"--project",
					"live-place-shared",
					"--testPathPattern",
					"src/shared/example.spec",
				],
				{
					cwd: sandbox,
					env: liveEnvironment(),
					timeoutMs: RUN_TIMEOUT_MS,
				},
			);

			expect(
				patternResult.exitCode,
				`stderr: ${patternResult.stderr}\nstdout: ${patternResult.stdout}`,
			).toBe(0);
			expect(patternResult.stdout).toContain("1 passed");
		},
		RUN_TIMEOUT_MS + 5000,
	);

	// Regression: native Roblox `warn(...)` emitted from a spec must
	// be captured into the `--gameOutput` JSON dump. Pre-#150 used
	// LogService:GetLogHistory which captured all output; #150 swapped to
	// InterceptWriteable on Jest's process.stdout/stderr, which only sees
	// Jest's reporter writes — native warn/print never flows through it,
	// so the dump file became `[]` for any real game output. Live fixture
	// drops a marker warn inside the passing spec; assertion confirms the
	// marker reaches the JSON file.
	//
	// Note: after editing fixture sources, run `rm -rf
	// tools/jest-roblox-cli/test/e2e/fixtures/live-place/out` once so
	// global-setup's sentinel cache re-compiles the spec with the marker.
	it.runIf(isLive)(
		"should capture native warn() from a spec into the --gameOutput dump",
		async () => {
			expect.assertions(4);

			const sandbox = createFixtureSandbox(LIVE_FIXTURE_PATH);
			const gameOutputPath = path.join(sandbox, "game-output.json");
			const result = await runCliAsync(
				[
					"--backend",
					"open-cloud",
					"--config",
					"jest.config.ts",
					"--project",
					"live-place-shared",
					"--gameOutput",
					gameOutputPath,
				],
				{
					cwd: sandbox,
					env: liveEnvironment(),
					timeoutMs: RUN_TIMEOUT_MS,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(fs.existsSync(gameOutputPath)).toBeTrue();

			const raw = JSON.parse(fs.readFileSync(gameOutputPath, "utf-8"));
			const entries = gameOutputSchema.assert(raw).flatMap((group) => group.entries);

			expect(entries.length).toBeGreaterThan(0);
			expect(
				entries.some((entry) => entry.message.includes("game-output marker")),
			).toBeTrue();
		},
		RUN_TIMEOUT_MS + 5000,
	);

	it.runIf(isLive)(
		"should produce a typescript-keyed coverage report with non-zero statement counts",
		async () => {
			expect.assertions(4);

			const sandbox = createFixtureSandbox(LIVE_FIXTURE_PATH);
			const result = await runCliAsync(
				[
					"--backend",
					"open-cloud",
					"--config",
					"jest.config.ts",
					"--project",
					"live-place-shared",
					"--coverage",
					"--coverageReporters",
					"json",
				],
				{
					cwd: sandbox,
					env: liveEnvironment(),
					timeoutMs: RUN_TIMEOUT_MS,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);

			const reportPath = path.join(sandbox, "coverage", "coverage-final.json");

			expect(fs.existsSync(reportPath)).toBeTrue();

			const raw = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
			const report = coverageReportSchema.assert(raw);
			const keys = Object.keys(report);

			expect(keys.some((key) => key.endsWith(".ts"))).toBeTrue();
			expect(
				Object.values(report).some((entry) =>
					Object.values(entry.s).some((count) => count > 0),
				),
			).toBeTrue();
		},
		RUN_TIMEOUT_MS + 5000,
	);
});

// Regression: stub-injection refactor (PR #464). Multi-project shape with
// two inline-object entries — one mount has no user-authored config, the
// other already has a `jest.config.luau` Rojo will sync. Per-mount FS
// detection via `hasUserAuthoredConfig` must gate both stub generation and
// the synthesizer's stubMount construction: the user's file at `src/b`
// stays byte-identical, no cache stub lands at `src/b`, and the inline
// entry at `src/a` still gets its generated cache stub. Unit-tested via
// mocks in `stubs.spec.ts`, but the full multi-project pipeline wiring
// has no prior e2e — direct-Luau users with a hand-authored config at one
// mount are the primary failure mode this guards.
describe("multi-project per-mount user-authored config respect", () => {
	it.skipIf(!rojoOnPath())(
		"should leave user-authored jest.config.luau untouched while generating cache stubs for mounts without user files",
		async () => {
			expect.assertions(6);

			const sandbox = createFixtureSandbox(USER_AUTHORED_FIXTURE_PATH);
			const userConfigPath = path.join(sandbox, "src/b/jest.config.luau");
			const seededUserConfig = fs.readFileSync(userConfigPath);

			const server = await startFakeOpenCloudServer([
				{ jestOutput: passingJestOutput(), pkg: "a", project: "a" },
				{ jestOutput: passingJestOutput(), pkg: "b", project: "b" },
			]);

			const result = await runCliAsync(["--backend", "open-cloud", "--parallel=2"], {
				cwd: sandbox,
				env: {
					JEST_ROBLOX_OPEN_CLOUD_BASE_URL: server.baseUrl,
					ROBLOX_OPEN_CLOUD_API_KEY: "test-api-key",
					ROBLOX_PLACE_ID: "456",
					ROBLOX_UNIVERSE_ID: "123",
				},
				timeoutMs: 60_000,
			});

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			// User-authored file survives byte-for-byte — never overwritten
			// by a generated marker stub.
			expect(fs.existsSync(userConfigPath)).toBeTrue();
			expect(fs.readFileSync(userConfigPath).equals(seededUserConfig)).toBeTrue();

			// Project "a" mount has no user file → cache stub generated with
			// the load-bearing marker prefix.
			const aCacheStubPath = path.join(sandbox, ".jest-roblox/cache/src/a/jest.config.luau");

			expect(fs.existsSync(aCacheStubPath)).toBeTrue();
			expect(
				fs
					.readFileSync(aCacheStubPath, "utf-8")
					.startsWith("-- Auto-generated by jest-roblox (do not edit)\n"),
			).toBeTrue();

			// Project "b" mount has a user file → generation must skip it
			// entirely. No cache stub lands at `.jest-roblox/cache/src/b/`.
			expect(
				fs.existsSync(path.join(sandbox, ".jest-roblox/cache/src/b/jest.config.luau")),
			).toBeFalse();
		},
		60_000,
	);
});

function liveEnvironment(): Record<string, string | undefined> {
	return {
		JEST_ROBLOX_LIVE: process.env["JEST_ROBLOX_LIVE"],
		ROBLOX_OPEN_CLOUD_API_KEY: process.env["ROBLOX_OPEN_CLOUD_API_KEY"],
		ROBLOX_PLACE_ID: process.env["ROBLOX_PLACE_ID"],
		ROBLOX_UNIVERSE_ID: process.env["ROBLOX_UNIVERSE_ID"],
	};
}
