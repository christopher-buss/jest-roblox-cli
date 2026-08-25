import { type } from "arktype";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createFixtureSandbox, runCliAsync } from "../cli/helpers.ts";
import { IS_LIVE, liveEnvironment } from "./live-gate.ts";

/**
 * The live pipeline suite. Gated on JEST_ROBLOX_LIVE=1 plus the three Open
 * Cloud env vars; with the gate off vitest reports these skipped and the wire
 * is never touched, so the file runs on a machine without secrets.
 *
 * Every test here costs a place upload, and an upload is the one thing
 * measured to precede a ~20s cold place boot (see
 * `docs/research/open-cloud-warm-boot`). So the unit of economy is the CLI
 * invocation, not the test: flags that can share a run do share one, and each
 * `it` below is one invocation. Adding a case means asking first whether an
 * existing run can carry the assertion.
 *
 * The fixture (`test/e2e/fixtures/live-place`) ships a pre-built `.rbxl` and
 * two configured `projects` in its `jest.config.ts` — `live-place-shared`
 * (one spec) and `live-place-server` (four).
 *
 * Only the first run below carries the boot probe. One live proof that a fresh
 * version starts is the whole of what the wire can tell us; every later run
 * would spend a task and a cold boot re-proving it, so they point at
 * `jest.no-probe.config.ts` instead.
 */

const LIVE_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/live-place");
const RUN_TIMEOUT_MS = 120_000;

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

describe("live pipeline", () => {
	// One invocation, four regressions. Each was its own live test until the
	// wall-clock made the case for merging: all four drive the same fixture
	// through the same both-mounts run, and their flags do not interact.
	//
	// 1. Results merge across both mounts, each under its own displayName.
	// 2. The runner resolves per-project config from the `jest.config`
	//    ModuleScript injected at each mount, and the rebuilt place loads.
	// 3. Native `warn(...)` from a spec reaches the `--gameOutput` dump.
	//    Pre-#150 used LogService:GetLogHistory; #150 swapped to
	//    InterceptWriteable on Jest's process.stdout/stderr, which only sees
	//    Jest's reporter writes, so the dump became `[]` for real game output.
	// 4. Coverage probes survive the round trip and map back to `.ts` keys.
	//
	// Note: after editing fixture sources, run `rm -rf
	// tools/jest-roblox-cli/test/e2e/fixtures/live-place/out` once so
	// global-setup's sentinel cache re-compiles the spec with the marker warn.
	it.runIf(IS_LIVE)(
		"should run both mounts, capture game output, and report coverage in one run",
		async () => {
			expect.assertions(10);

			const sandbox = createFixtureSandbox(LIVE_FIXTURE_PATH);
			const gameOutputPath = path.join(sandbox, "game-output.json");
			const result = await runCliAsync(
				[
					"--backend",
					"open-cloud",
					"--config",
					"jest.config.ts",
					"--gameOutput",
					gameOutputPath,
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
			// One shared spec plus four server ones (`server-thing` and the three
			// same-basename `index.spec` files the narrowing regression needs).
			expect(result.stdout, "both mounts ran").toContain("5 passed");
			expect(result.stdout, "shared mount reported").toContain("live-place-shared");
			expect(result.stdout, "server mount reported").toContain("live-place-server");

			// Refactor invariant: auto-stubs never land in source mount paths.
			// The cache stub at `.jest-roblox/cache/<mount>/jest.config.luau`
			// is canonical; the source-tree mount must stay clean.
			expect(
				fs.existsSync(path.join(sandbox, "out/shared/jest.config.luau")),
				"no stub in the shared source mount",
			).toBeFalse();
			expect(
				fs.existsSync(path.join(sandbox, "out/server/jest.config.luau")),
				"no stub in the server source mount",
			).toBeFalse();
			expect(
				fs.existsSync(path.join(sandbox, ".jest-roblox/cache/out/shared/jest.config.luau")),
				"cache stub generated",
			).toBeTrue();

			const gameOutput = gameOutputSchema.assert(
				JSON.parse(fs.readFileSync(gameOutputPath, "utf-8")),
			);

			expect(
				gameOutput.flatMap((group) => group.entries).map((entry) => entry.message),
				"native warn reached the dump",
			).toSatisfyAny((message) => message.includes("game-output marker"));

			const report = coverageReportSchema.assert(
				JSON.parse(
					fs.readFileSync(path.join(sandbox, "coverage", "coverage-final.json"), "utf-8"),
				),
			);

			expect(Object.keys(report), "coverage keyed by TypeScript source").toSatisfyAny(
				(key) => {
					return key.endsWith(".ts");
				},
			);
			expect(Object.values(report), "coverage counted an executed statement").toSatisfyAny(
				(entry) => Object.values(entry.s).some((count) => count > 0),
			);
		},
		RUN_TIMEOUT_MS + 5000,
	);

	// Regression: a positional file is forwarded to Jest-on-Roblox as a pattern,
	// and a basename-only pattern runs every namesake. The server mount ships
	// three specs that all compile to an Instance named `init.spec`, one of them
	// at `nested/namesake` so the named file's path is a bare suffix of it. "1
	// passed" therefore only holds if the forwarded pattern carries both the
	// path below the mount and the mount's own name.
	//
	// This is the only check that the FS→Instance namespace normalization
	// produces a string real Roblox-side Jest matches — a wrong assumption runs
	// 3 here, or 0. Which pattern `narrowConfigByFiles` and `narrowForLuauRun`
	// build from which input is settled off-wire in
	// `src/config/narrow-by-files.spec.ts`.
	it.runIf(IS_LIVE)(
		"should run only the named file when a namesake shares its basename",
		async () => {
			expect.assertions(4);

			const sandbox = createFixtureSandbox(LIVE_FIXTURE_PATH);
			const result = await runCliAsync(
				[
					"--backend",
					"open-cloud",
					"--config",
					"jest.no-probe.config.ts",
					"src/server/namesake/index.spec.ts",
				],
				{
					cwd: sandbox,
					env: liveEnvironment(),
					timeoutMs: RUN_TIMEOUT_MS,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(result.stdout).toContain("1 passed");
			expect(result.stdout).not.toContain("other/index.spec");
			expect(result.stdout).not.toContain("nested/namesake/index.spec");
		},
		RUN_TIMEOUT_MS + 5000,
	);
});
