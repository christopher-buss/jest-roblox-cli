import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServer } from "../cli/fake-open-cloud.ts";
import { createFixtureSandbox, runCliAsync } from "../cli/helpers.ts";

// Live multi-root workspace pipeline test. Gated on JEST_ROBLOX_LIVE=1 plus
// the three Open Cloud env vars (`ROBLOX_OPEN_CLOUD_API_KEY`,
// `ROBLOX_UNIVERSE_ID`, `ROBLOX_PLACE_ID`). When the gate is off the test
// stays dormant — vitest reports it as skipped, the live wire is never
// touched, and the file can run on machines without secrets.
//
// The fixture (`test/e2e/fixtures/live-place`) ships a pre-built `.rbxl` plus
// two configured `projects` in its `jest.config.ts` (`live-place-shared` and
// `live-place-server`). Running without `--project` exercises both mounts so
// the assertion verifies the multi-root pipeline merges results across them.

const LIVE_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/live-place");
const WORKSPACE_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/workspace");
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

describe("live workspace pipeline", () => {
	it.runIf(isLive)(
		"should merge results from both mounts end-to-end against live Open Cloud",
		async () => {
			expect.assertions(7);

			const sandbox = createFixtureSandbox(LIVE_FIXTURE_PATH);
			const result = await runCliAsync(
				["--backend", "open-cloud", "--config", "jest.config.ts"],
				{
					cwd: sandbox,
					env: liveEnvironment(),
					timeoutMs: RUN_TIMEOUT_MS,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(result.stdout).toContain("2 passed");
			expect(result.stdout).toContain("live-place-shared");
			expect(result.stdout).toContain("live-place-server");

			// Refactor invariant: auto-stubs never land in source mount paths.
			// The cache stub at `.jest-roblox/cache/<mount>/jest.config.luau`
			// is canonical; the source-tree mount must stay clean.
			expect(fs.existsSync(path.join(sandbox, "out/shared/jest.config.luau"))).toBe(false);
			expect(fs.existsSync(path.join(sandbox, "out/server/jest.config.luau"))).toBe(false);
			expect(
				fs.existsSync(
					path.join(sandbox, ".jest-roblox/cache/out/shared/jest.config.luau"),
				),
			).toBe(true);
		},
		RUN_TIMEOUT_MS + 5000,
	);
});

// Workspace + --parallel exercises the work-stealing path: per-run MemoryStore
// queue populated with every (pkg, project), N OCALE tasks all running the
// same materializer script, and entries from all envelopes aggregated by
// pkg::project. Driven through the fake Open Cloud server so the test stays
// fast and runs without secrets.
describe("workspace --parallel work-stealing", () => {
	it.skipIf(!rojoOnPath())(
		"should populate the MemoryStore queue and fan results across N parallel tasks",
		async () => {
			expect.assertions(5);

			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);

			const server = await startFakeOpenCloudServer([
				{ jestOutput: passingJestOutput(), pkg: "@e2e/foo", project: "@e2e/foo" },
				{ jestOutput: passingJestOutput(), pkg: "@e2e/bar", project: "@e2e/bar" },
			]);

			const result = await runCliAsync(
				[
					"--workspace",
					"--packages=@e2e/foo,@e2e/bar",
					"--parallel=2",
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
					timeoutMs: 60_000,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			// Both packages get pushed onto the per-run queue.
			expect(server.queueAdds.map((entry) => entry.value)).toIncludeAllMembers([
				{ pkg: "@e2e/foo", project: "@e2e/foo" },
				{ pkg: "@e2e/bar", project: "@e2e/bar" },
			]);
			// Two parallel tasks fired against the same shared queueId.
			expect(server.requests).toHaveLength(2);

			const queueIds = server.requests.map(
				(request) => /"queueId":"([^"]+)"/.exec(request.script)?.[1] ?? "",
			);

			expect(new Set(queueIds).size).toBe(1);
			// Single place upload regardless of --parallel.
			expect(server.uploadCount).toBe(1);
		},
		60_000,
	);
});

// Regression: a package whose rojo declares a `$path`-mounted parent (e.g.
// `Tests: { $path: "out-test" }`) with no explicit child for the sub-directory
// targeted by `outDir: "out-test/src"`. Before the synthesizer learned to
// virtualize the missing `Tests/src` child from the on-disk directory, the
// workspace runner crashed with `stubMount dataModelPath ... does not resolve
// in synthesized tree (missing segment "src")` before reaching the backend.
describe("workspace synthesizer $path-mounted parent virtualization", () => {
	it.skipIf(!rojoOnPath())(
		"should reach backend dispatch when stubMount targets a sub-directory of a $path-mounted parent",
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
				["--workspace", "--packages=@e2e/nested", "--backend", "open-cloud"],
				{
					cwd: sandbox,
					env: {
						JEST_ROBLOX_OPEN_CLOUD_BASE_URL: server.baseUrl,
						ROBLOX_OPEN_CLOUD_API_KEY: "test-api-key",
						ROBLOX_PLACE_ID: "456",
						ROBLOX_UNIVERSE_ID: "123",
					},
					timeoutMs: 60_000,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(result.stderr).not.toContain("does not resolve in synthesized tree");
			// Guard against silent short-circuits (e.g. zero-discovery passes
			// without ever reaching backend dispatch).
			expect(server.requests).toHaveLength(1);
			expect(server.uploadCount).toBe(1);
		},
		60_000,
	);
});

// Regression: a workspace package with `jest.config` + `outDir` pointing at a
// sub-directory that doesn't exist on disk (the package has no specs, so the
// compiler produces no output there). Before stubMount emission learned to
// skip zero-test projects, the synthesizer crashed walking the missing
// segment — but only when at least one OTHER package had pending tests, so
// the workspace runner reached `writeStubsAndBuildDescriptors` instead of
// short-circuiting on `pending.length === 0`. The mixed `@e2e/foo` +
// `@e2e/empty-tests` invocation is what surfaces the bug.
describe("workspace synthesizer zero-test project tolerance", () => {
	it.skipIf(!rojoOnPath())(
		"should not emit stubMounts for projects with no discovered tests",
		async () => {
			expect.assertions(4);

			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);

			const server = await startFakeOpenCloudServer([
				{ jestOutput: passingJestOutput(), pkg: "@e2e/foo", project: "@e2e/foo" },
			]);

			const result = await runCliAsync(
				["--workspace", "--packages=@e2e/foo,@e2e/empty-tests", "--backend", "open-cloud"],
				{
					cwd: sandbox,
					env: {
						JEST_ROBLOX_OPEN_CLOUD_BASE_URL: server.baseUrl,
						ROBLOX_OPEN_CLOUD_API_KEY: "test-api-key",
						ROBLOX_PLACE_ID: "456",
						ROBLOX_UNIVERSE_ID: "123",
					},
					timeoutMs: 60_000,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(result.stderr).not.toContain("does not resolve in synthesized tree");
			// Populated package still dispatches; empty-tests contributes
			// nothing to the backend queue.
			expect(server.requests).toHaveLength(1);
			expect(server.uploadCount).toBe(1);
		},
		60_000,
	);
});

// Regression: stub-injection refactor (PR #464). A pre-refactor multi-project
// run leaves a marker-bearing `jest.config.luau` in the user's source tree
// (multi-project mode used to write stubs there directly). When the same
// package is then run via workspace mode, the synthesizer's
// `assertNoSourceCollision` would refuse to inject from the cache because a
// pre-existing file already sits at the mount fsPath — re-triggering the
// cross-mode bug the refactor exists to fix. The workspace runner's
// pre-flight `cleanLeftoverStubs` walks each live project's mount paths,
// deletes only marker-bearing files, and surfaces a stderr notice.
describe("workspace pre-flight cleanup of leftover own-stubs", () => {
	it.skipIf(!rojoOnPath())(
		"should delete marker-bearing source-tree stubs left by a prior multi-project run",
		async () => {
			expect.assertions(4);

			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);
			// `@e2e/foo`'s rojo project mounts `ReplicatedStorage/Foo` from
			// `src` (see fixtures/workspace/packages/foo/test.project.json),
			// so a pre-refactor multi-project run would have written its
			// generated stub at `packages/foo/src/jest.config.luau`. Seed
			// that exact path with the marker prefix.
			const leftoverPath = path.join(sandbox, "packages/foo/src/jest.config.luau");
			fs.writeFileSync(
				leftoverPath,
				"-- Auto-generated by jest-roblox (do not edit)\nreturn {}\n",
			);

			const server = await startFakeOpenCloudServer([
				{ jestOutput: passingJestOutput(), pkg: "@e2e/foo", project: "@e2e/foo" },
			]);

			const result = await runCliAsync(
				["--workspace", "--packages=@e2e/foo", "--backend", "open-cloud"],
				{
					cwd: sandbox,
					env: {
						JEST_ROBLOX_OPEN_CLOUD_BASE_URL: server.baseUrl,
						ROBLOX_OPEN_CLOUD_API_KEY: "test-api-key",
						ROBLOX_PLACE_ID: "456",
						ROBLOX_UNIVERSE_ID: "123",
					},
					timeoutMs: 60_000,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			// Pre-flight cleanup removed the marker-bearing file before the
			// synthesizer's `assertNoSourceCollision` got to look at it.
			expect(fs.existsSync(leftoverPath)).toBe(false);
			// Notice format is fixed by `workspace-runner.ts:209-212`.
			expect(result.stderr).toContain("cleaned 1 leftover stub(s) from @e2e/foo");
			// Server-side: the run actually reached backend dispatch (guards
			// against a CLI short-circuit that would let the cleanup-only
			// assertions pass without exercising the pipeline).
			expect(server.requests).toHaveLength(1);
		},
		60_000,
	);
});

// Regression: HAL-165 per-package snapshot writeback only landed on disk in
// single-package mode because `writeSnapshots` interpreted relative
// `config.rojoProject` against process.cwd(). Single-pkg happens to launch
// with CWD == rootDir so the lookup coincidentally worked; workspace mode
// runs from the workspace root and every per-package lookup missed,
// silently dropping every captured snapshot.
//
// The original HAL-165 tests asserted on the in-memory envelope (envelope
// parsing, per-package routing dispatch) but stopped before writeSnapshots,
// so the disk-write regression slipped through. This e2e drives the full
// pipeline through the fake OCALE backend with `snapshotWrites` populated
// on the envelope and asserts each package's snapshot file lands at its own
// rootDir-relative `__snapshots__/` location — the disk shape the fix
// (`path.resolve(config.rootDir, ...)`) guarantees.
describe("workspace snapshot writeback lands per-package on disk", () => {
	it.skipIf(!rojoOnPath())(
		"should write each package's snapshotWrites to its own rootDir/__snapshots__",
		async () => {
			expect.assertions(5);

			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);
			const fooSnapshot = "-- @e2e/foo snapshot body\nreturn { pkg = 'foo' }\n";
			const barSnapshot = "-- @e2e/bar snapshot body\nreturn { pkg = 'bar' }\n";

			const server = await startFakeOpenCloudServer([
				{
					jestOutput: passingJestOutput(),
					pkg: "@e2e/foo",
					project: "@e2e/foo",
					snapshotWrites: {
						"ReplicatedStorage/Foo/__snapshots__/hal-165.spec.snap.luau": fooSnapshot,
					},
				},
				{
					jestOutput: passingJestOutput(),
					pkg: "@e2e/bar",
					project: "@e2e/bar",
					snapshotWrites: {
						"ReplicatedStorage/Bar/__snapshots__/hal-165.spec.snap.luau": barSnapshot,
					},
				},
			]);

			const result = await runCliAsync(
				[
					"--workspace",
					"--packages=@e2e/foo,@e2e/bar",
					"--parallel=2",
					"--updateSnapshot",
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
					timeoutMs: 60_000,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(result.stderr).not.toContain("Cannot write snapshots - no rojo project found");
			// Server-side invariants: confirm the fake OCALE backend was actually
			// exercised — without these, a CLI short-circuit (zero discovery,
			// early validation failure) could let the file-existence assertions
			// pass on stale disk state from a prior run. One upload regardless
			// of --parallel (single synthesized place); one task per parallel
			// worker (2).
			expect(server.uploadCount).toBe(1);
			expect(server.requests).toHaveLength(2);

			const fooSnapPath = path.join(
				sandbox,
				"packages/foo/src/__snapshots__/hal-165.spec.snap.luau",
			);
			const barSnapPath = path.join(
				sandbox,
				"packages/bar/src/__snapshots__/hal-165.spec.snap.luau",
			);

			// Cross-contamination guard: each package's body lives only under
			// its own __snapshots__ tree. readFileSync throws ENOENT if a
			// snapshot is missing entirely.
			expect({
				bar: fs.readFileSync(barSnapPath, "utf-8"),
				foo: fs.readFileSync(fooSnapPath, "utf-8"),
			}).toStrictEqual({ bar: barSnapshot, foo: fooSnapshot });
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
