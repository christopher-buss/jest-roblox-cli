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

const WORKSPACE_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/workspace");

// Workspace + --parallel exercises the work-stealing path: per-run MemoryStore
// queue populated with every (pkg, project), N OCALE tasks all running the
// same materializer script, and entries from all envelopes aggregated by
// pkg::project. Driven through the fake Open Cloud server so the test stays
// fast and runs without secrets.
//
// `--updateSnapshot` rides along on the same invocation, because it is the same
// two-package parallel run and the flags do not interact. Its own regression:
// per-package snapshot writeback only landed on disk in single-package mode,
// because `writeSnapshots` interpreted a relative `config.rojoProject` against
// `process.cwd()`. Single-pkg happens to launch with CWD == rootDir so the
// lookup coincidentally worked; workspace mode runs from the workspace root, so
// every per-package lookup missed and silently dropped every captured snapshot.
// The tests that came before asserted on the in-memory envelope and stopped
// short of `writeSnapshots`, which is how the disk-write regression slipped
// through — so the assertion here is the file on disk, at the rootDir-relative
// location `path.resolve(config.rootDir, ...)` guarantees.
describe("workspace --parallel work-stealing", () => {
	it.skipIf(!rojoOnPath())(
		"should fan results across N parallel tasks and write each package's snapshots",
		async () => {
			expect.assertions(7);

			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);
			const fooSnapshot = "-- @e2e/foo snapshot body\nreturn { pkg = 'foo' }\n";
			const barSnapshot = "-- @e2e/bar snapshot body\nreturn { pkg = 'bar' }\n";

			const server = await startFakeOpenCloudServerAsync([
				{
					jestOutput: buildPassingJestOutput(),
					pkg: "@e2e/foo",
					project: "@e2e/foo",
					snapshotWrites: {
						"ReplicatedStorage/Foo/__snapshots__/hal-165.spec.snap.luau": fooSnapshot,
					},
				},
				{
					jestOutput: buildPassingJestOutput(),
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
					env: createOpenCloudEnvironment(server.baseUrl),
					timeoutMs: 60_000,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(result.stderr).not.toContain("Cannot write snapshots - no rojo project found");
			// Both packages get pushed onto the per-run queue.
			expect(server.queueAdds.map((entry) => entry.value)).toIncludeAllMembers([
				{ pkg: "@e2e/foo", project: "@e2e/foo" },
				{ pkg: "@e2e/bar", project: "@e2e/bar" },
			]);
			// Two parallel tasks fired against the same shared queueId.
			expect(server.requests).toHaveLength(2);

			const queueIds = server.requests.map(
				(request) => /"queueId":"([^"]+)"/.exec(request.script)![1]!,
			);

			const uniqueQueueIds = new Set(queueIds);

			expect(uniqueQueueIds.size).toBe(1);
			// Single place upload regardless of --parallel.
			expect(server.uploadCount).toBe(1);

			// Cross-contamination guard: each package's body lives only under
			// its own __snapshots__ tree. readFileSync throws ENOENT if a
			// snapshot is missing entirely.
			expect({
				bar: fs.readFileSync(
					path.join(sandbox, "packages/bar/src/__snapshots__/hal-165.spec.snap.luau"),
					"utf-8",
				),
				foo: fs.readFileSync(
					path.join(sandbox, "packages/foo/src/__snapshots__/hal-165.spec.snap.luau"),
					"utf-8",
				),
			}).toStrictEqual({ bar: barSnapshot, foo: fooSnapshot });
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

			const server = await startFakeOpenCloudServerAsync([
				{
					jestOutput: buildPassingJestOutput(),
					pkg: "@e2e/nested",
					project: "@e2e/nested",
				},
			]);

			const result = await runCliAsync(
				["--workspace", "--packages=@e2e/nested", "--backend", "open-cloud"],
				{
					cwd: sandbox,
					env: createOpenCloudEnvironment(server.baseUrl),
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

			const server = await startFakeOpenCloudServerAsync([
				{ jestOutput: buildPassingJestOutput(), pkg: "@e2e/foo", project: "@e2e/foo" },
			]);

			const result = await runCliAsync(
				["--workspace", "--packages=@e2e/foo,@e2e/empty-tests", "--backend", "open-cloud"],
				{
					cwd: sandbox,
					env: createOpenCloudEnvironment(server.baseUrl),
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

			const server = await startFakeOpenCloudServerAsync([
				{ jestOutput: buildPassingJestOutput(), pkg: "@e2e/foo", project: "@e2e/foo" },
			]);

			const result = await runCliAsync(
				["--workspace", "--packages=@e2e/foo", "--backend", "open-cloud"],
				{
					cwd: sandbox,
					env: createOpenCloudEnvironment(server.baseUrl),
					timeoutMs: 60_000,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			// Pre-flight cleanup removed the marker-bearing file before the
			// synthesizer's `assertNoSourceCollision` got to look at it.
			expect(fs.existsSync(leftoverPath)).toBeFalse();
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

// A bare `--workspace` enumerates the workspace itself, so the two things that
// decide its package set are unreachable from the `--packages` invocations
// above: the pnpm source's `jest.config.*` gate, and `workspace.exclude`.
//
// One invocation covers both. The exclude narrows the seven fixture packages
// down to `@e2e/nested` — which keeps this to a single dispatch — and the
// fixture's `packages/no-tests` carries a package.json with no jest config, so
// a run that reached it at all would dispatch a second time.
describe("workspace bare enumeration", () => {
	it.skipIf(!rojoOnPath())(
		"should select every package the exclude leaves and skip one with no jest.config",
		async () => {
			expect.assertions(4);

			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);
			fs.writeFileSync(
				path.join(sandbox, "jest.config.ts"),
				[
					"export default {",
					"\tworkspace: {",
					"\t\texclude: [",
					'\t\t\t"packages/bar",',
					'\t\t\t"packages/empty-tests",',
					'\t\t\t"packages/foo",',
					'\t\t\t"packages/typed",',
					'\t\t\t"packages/typed-broken",',
					'\t\t\t"packages/vendored-mount",',
					"\t\t],",
					"\t},",
					"};",
					"",
				].join("\n"),
			);

			const server = await startFakeOpenCloudServerAsync([
				{
					jestOutput: buildPassingJestOutput(),
					pkg: "@e2e/nested",
					project: "@e2e/nested",
				},
			]);

			const result = await runCliAsync(["--workspace", "--backend", "open-cloud"], {
				cwd: sandbox,
				env: createOpenCloudEnvironment(server.baseUrl),
				timeoutMs: 60_000,
			});

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			expect(server.requests).toHaveLength(1);
			// The dispatched script carries the selected package set, so a
			// package the exclude or the jest.config gate should have dropped
			// shows up here rather than as a silent extra elsewhere.
			expect(server.requests[0]!.script).toContain('"pkg":"@e2e/nested"');
			expect(server.requests[0]!.script).not.toContain("@e2e/foo");
		},
		60_000,
	);
});
