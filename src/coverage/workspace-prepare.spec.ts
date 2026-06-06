import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { INSTRUMENTER_VERSION } from "./instrumenter.ts";
import type { CoverageManifest, InstrumentedFileRecord } from "./manifest.ts";
import { MANIFEST_VERSION, manifestSchema } from "./manifest.ts";
import { prepareWorkspaceCoverage } from "./workspace-prepare.ts";

function sha256(content: string): string {
	return crypto.createHash("sha256").update(content).digest("hex");
}

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, cpSync: memfs.vol.cpSync.bind(memfs.vol), default: memfs.fs });
});
vi.mock(import("./instrumenter"));

const WORKSPACE_ROOT = path.resolve("/repo");
const FOO_DIR = path.join(WORKSPACE_ROOT, "packages/foo");
const BAR_DIR = path.join(WORKSPACE_ROOT, "packages/bar");
const FOO_PROJECT = path.join(FOO_DIR, "test.project.json");
const BAR_PROJECT = path.join(BAR_DIR, "test.project.json");

interface SeedOptions {
	luauRoots?: Array<string>;
	rojoTree?: object;
}

function seedPackage(packageDirectory: string, options: SeedOptions = {}): void {
	const {
		luauRoots = ["out"],
		rojoTree = {
			$className: "DataModel",
			ReplicatedStorage: { Pkg: { $path: "out" } },
		},
	} = options;

	vol.fromJSON({
		[path.join(packageDirectory, "test.project.json")]: JSON.stringify({
			name: "pkg-test",
			tree: rojoTree,
		}),
	});
	for (const luauRoot of luauRoots) {
		vol.mkdirSync(path.join(packageDirectory, luauRoot), { recursive: true });
		vol.writeFileSync(path.join(packageDirectory, luauRoot, "init.luau"), "local x = 1");
	}
}

async function mockInstrumentRoot(
	implementation?: (options: {
		luauRoot: string;
		shadowDir: string;
	}) => Record<string, InstrumentedFileRecord>,
): Promise<ReturnType<typeof vi.fn>> {
	const { instrumentRoot } = await import("./instrumenter.ts");
	const mocked = vi.mocked(instrumentRoot);
	mocked.mockImplementation(
		implementation ??
			(({ luauRoot }) => {
				const key = `${luauRoot}/init.luau`;
				return {
					[key]: {
						key,
						coverageMapPath: `${luauRoot}/init.cov-map.json`,
						instrumentedLuauPath: `${luauRoot}/init.luau`,
						originalLuauPath: `${luauRoot}/init.luau`,
						sourceHash: "deadbeef",
						sourceMapPath: `${luauRoot}/init.luau.map`,
						statementCount: 1,
					},
				};
			}),
	);
	return mocked;
}

describe(prepareWorkspaceCoverage, () => {
	it("should return per-package coverage roots whose luauRoot is package-relative and shadowDir is absolute", async () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		seedPackage(FOO_DIR);
		await mockInstrumentRoot();

		const result = prepareWorkspaceCoverage({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(result).toHaveLength(1);
		expect(result[0]?.coverageRoots).toStrictEqual([
			{
				luauRoot: "out",
				shadowDir: path
					.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out")
					.replaceAll("\\", "/"),
			},
		]);
	});

	it("should write a per-package manifest at workspace-root-scoped path", async () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		seedPackage(FOO_DIR);
		await mockInstrumentRoot();

		const result = prepareWorkspaceCoverage({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		const expectedPath = path.join(
			WORKSPACE_ROOT,
			".jest-roblox/workspace/@halcyon-foo/coverage/coverage-manifest.json",
		);

		expect(result[0]?.manifestPath).toBe(expectedPath.replaceAll("\\", "/"));
		expect(vol.existsSync(expectedPath)).toBeTrue();
	});

	it("should call instrumentRoot once per discovered luau root in each package", async () => {
		expect.assertions(3);

		onTestFinished(() => {
			vol.reset();
		});

		seedPackage(FOO_DIR, {
			luauRoots: ["out/client", "out/server"],
			rojoTree: {
				$className: "DataModel",
				ReplicatedStorage: { Client: { $path: "out/client" } },
				ServerScriptService: { Server: { $path: "out/server" } },
			},
		});
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).toHaveBeenCalledTimes(2);

		const luauRoots = mocked.mock.calls.map(
			(call) => (call[0] as { luauRoot: string }).luauRoot,
		);

		expect(luauRoots).toContain(path.join(FOO_DIR, "out/client").replaceAll("\\", "/"));
		expect(luauRoots).toContain(path.join(FOO_DIR, "out/server").replaceAll("\\", "/"));
	});

	it("should isolate shadow dirs and manifests between packages", async () => {
		expect.assertions(4);

		onTestFinished(() => {
			vol.reset();
		});

		seedPackage(FOO_DIR);
		seedPackage(BAR_DIR);
		await mockInstrumentRoot();

		const result = prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
				{ name: "@halcyon/bar", packageDirectory: BAR_DIR, rojoProjectPath: BAR_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		const fooManifest = path.join(
			WORKSPACE_ROOT,
			".jest-roblox/workspace/@halcyon-foo/coverage/coverage-manifest.json",
		);
		const barManifest = path.join(
			WORKSPACE_ROOT,
			".jest-roblox/workspace/@halcyon-bar/coverage/coverage-manifest.json",
		);

		expect(result.find((entry) => entry.pkg === "@halcyon/foo")?.manifestPath).toBe(
			fooManifest.replaceAll("\\", "/"),
		);
		expect(result.find((entry) => entry.pkg === "@halcyon/bar")?.manifestPath).toBe(
			barManifest.replaceAll("\\", "/"),
		);
		expect(vol.existsSync(fooManifest)).toBeTrue();
		expect(vol.existsSync(barManifest)).toBeTrue();
	});

	it("should aggregate instrumented file records into the per-package manifest", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		seedPackage(FOO_DIR);
		await mockInstrumentRoot();

		const [result] = prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		const manifest = manifestSchema.assert(
			JSON.parse(vol.readFileSync(result!.manifestPath, "utf-8") as string),
		);
		const expectedKey = `${path.join(FOO_DIR, "out").replaceAll("\\", "/")}/init.luau`;

		expect(Object.keys(manifest.files)).toContain(expectedKey);
	});

	// Codex review follow-up: on a cold run, prepareShadowRoot only
	// does mkdirSync + cpSync (both merge). If a prior run wrote files into
	// the package shadow that have since been deleted from source — or the
	// cache is invalid / version-stale and we fall back to a cold run — those
	// stale files survive into the redirected $path mount. Single-package
	// prepares avoid this by rmSync-ing COVERAGE_DIR before instrumenting;
	// workspace must nuke its own per-package shadow root for symmetry.
	it("should remove stale shadow files when running cold (no cache)", async () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		const packageShadow = path
			.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage")
			.replaceAll("\\", "/");
		const staleSpecPath = path.join(packageShadow, "out/stale.spec.luau");

		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Pkg: { $path: "out" } },
				},
			}),
			[path.join(FOO_DIR, "out/init.luau")]: "local x = 1",
			// Stale spec from a prior run — source has no matching file.
			[staleSpecPath]: "return {}",
		});
		await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		// Stale shadow file gone — rmSync of package shadow before cpSync.
		expect(vol.existsSync(staleSpecPath)).toBeFalse();
		// Current source still landed via cpSync.
		expect(vol.existsSync(path.join(packageShadow, "out/init.luau"))).toBeTrue();
	});

	it("should bypass a full cache hit when the descriptor opts out via per-pkg coverageCache", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		// Cache opt-out is per-package. Set up a full cache-hit
		// scenario (matching `should skip instrumentRoot on a full cache
		// hit` below) — the workspace-root config keeps the default
		// `coverageCache: true`, the manifest matches the current source, and
		// the only thing forcing re-instrumentation is the per-pkg
		// descriptor's `coverageCache: false`.
		const sourceContent = "local x = 1";
		const absoluteSourceRoot = path.join(FOO_DIR, "out").replaceAll("\\", "/");
		const fileKey = `${absoluteSourceRoot}/init.luau`;
		const packageShadow = path
			.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage")
			.replaceAll("\\", "/");
		const previousManifest: CoverageManifest = {
			buildId: "prev-build-id",
			files: {
				[fileKey]: {
					key: fileKey,
					coverageMapPath: `${packageShadow}/out/init.cov-map.json`,
					instrumentedLuauPath: `${packageShadow}/out/init.luau`,
					originalLuauPath: fileKey,
					sourceHash: sha256(sourceContent),
					sourceMapPath: `${packageShadow}/out/init.luau.map`,
					statementCount: 1,
				},
			},
			generatedAt: "2025-01-01T00:00:00.000Z",
			instrumenterVersion: INSTRUMENTER_VERSION,
			luauRoots: [`${packageShadow}/out`],
			nonInstrumentedFiles: {},
			shadowDir: packageShadow,
			version: MANIFEST_VERSION,
		};

		vol.fromJSON({
			[`${packageShadow}/out/init.cov-map.json`]: "{}",
			[`${packageShadow}/out/init.luau`]: "instrumented",
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Pkg: { $path: "out" } },
				},
			}),
			[path.join(FOO_DIR, "out/init.luau")]: sourceContent,
			[path.join(
				WORKSPACE_ROOT,
				".jest-roblox/workspace/@halcyon-foo/coverage/coverage-manifest.json",
			)]: JSON.stringify(previousManifest),
		});
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			packages: [
				{
					name: "@halcyon/foo",
					coverageCache: false,
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		// Cache disabled → cold path: instrumenter runs even though the manifest
		// matched.
		expect(mocked).toHaveBeenCalledOnce();
	});

	it("should discard a manifest with a stale instrumenter version", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const sourceContent = "local x = 1";
		const fileKey = `${path.join(FOO_DIR, "out").replaceAll("\\", "/")}/init.luau`;
		const previousManifest: CoverageManifest = {
			buildId: "prev-build-id",
			files: {
				[fileKey]: {
					key: fileKey,
					coverageMapPath: "x",
					instrumentedLuauPath: "x",
					originalLuauPath: fileKey,
					sourceHash: sha256(sourceContent),
					sourceMapPath: "x",
					statementCount: 1,
				},
			},
			generatedAt: "2025-01-01T00:00:00.000Z",
			instrumenterVersion: INSTRUMENTER_VERSION - 1,
			luauRoots: [],
			nonInstrumentedFiles: {},
			shadowDir: "x",
			version: MANIFEST_VERSION,
		};

		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Pkg: { $path: "out" } },
				},
			}),
			[path.join(FOO_DIR, "out/init.luau")]: sourceContent,
			[path.join(
				WORKSPACE_ROOT,
				".jest-roblox/workspace/@halcyon-foo/coverage/coverage-manifest.json",
			)]: JSON.stringify(previousManifest),
		});
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).toHaveBeenCalledOnce();
	});

	it.for([
		{
			name: "malformed JSON manifest",
			body: "{",
			expectedWarning: "malformed JSON",
		},
		{
			name: "schema-invalid manifest",
			body: JSON.stringify({ files: "not-an-object", version: MANIFEST_VERSION }),
			expectedWarning: "is invalid",
		},
	])("should warn and discard the cache for $name", async ({ body, expectedWarning }) => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		seedPackage(FOO_DIR);
		const manifestDirectory = path.join(
			WORKSPACE_ROOT,
			".jest-roblox/workspace/@halcyon-foo/coverage",
		);
		vol.mkdirSync(manifestDirectory, { recursive: true });
		vol.writeFileSync(path.join(manifestDirectory, "coverage-manifest.json"), body);
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).toHaveBeenCalledOnce();
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining(expectedWarning));
	});

	// Codex review follow-up: computeSkipFiles validates the
	// source hash but does NOT verify the manifest's referenced shadow
	// files still exist. If a partial cleanup or interrupted run leaves
	// the manifest pointing at missing files, the warm path would skip
	// re-instrumentation and the synthesized place would mount paths to
	// absent files. The cache record must be self-validating: source AND
	// outputs both have to be on disk for the skip to apply.
	it("should re-instrument when the cached shadow file is missing", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const sourceContent = "local x = 1";
		const absoluteSourceRoot = path.join(FOO_DIR, "out").replaceAll("\\", "/");
		const fileKey = `${absoluteSourceRoot}/init.luau`;
		const packageShadow = path
			.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage")
			.replaceAll("\\", "/");
		const previousManifest: CoverageManifest = {
			buildId: "prev-build-id",
			files: {
				[fileKey]: {
					key: fileKey,
					coverageMapPath: `${packageShadow}/out/init.cov-map.json`,
					instrumentedLuauPath: `${packageShadow}/out/init.luau`,
					originalLuauPath: fileKey,
					sourceHash: sha256(sourceContent),
					sourceMapPath: `${packageShadow}/out/init.luau.map`,
					statementCount: 1,
				},
			},
			generatedAt: "2025-01-01T00:00:00.000Z",
			instrumenterVersion: INSTRUMENTER_VERSION,
			luauRoots: [`${packageShadow}/out`],
			nonInstrumentedFiles: {},
			shadowDir: packageShadow,
			version: MANIFEST_VERSION,
		};

		// Manifest claims init.luau is fully cached, but the shadow files
		// the record points at don't exist on disk.
		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Pkg: { $path: "out" } },
				},
			}),
			[path.join(FOO_DIR, "out/init.luau")]: sourceContent,
			[path.join(
				WORKSPACE_ROOT,
				".jest-roblox/workspace/@halcyon-foo/coverage/coverage-manifest.json",
			)]: JSON.stringify(previousManifest),
		});
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		// Cache record points at a missing file → drop it from skipFiles
		// and call the instrumenter for a fresh run.
		expect(mocked).toHaveBeenCalledOnce();
	});

	// Workspace incremental cache: when the per-package manifest already
	// records the current source hash and coverageCache is on,
	// prepareShadowRoot should hit the full-cache path and not call the
	// instrumenter at all. Symmetric with single-package behavior in
	// prepare.spec.ts.
	it("should skip instrumentRoot on a full cache hit", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const sourceContent = "local x = 1";
		const absoluteSourceRoot = path.join(FOO_DIR, "out").replaceAll("\\", "/");
		const fileKey = `${absoluteSourceRoot}/init.luau`;
		const packageShadow = path
			.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage")
			.replaceAll("\\", "/");
		const previousManifest: CoverageManifest = {
			buildId: "prev-build-id",
			files: {
				[fileKey]: {
					key: fileKey,
					coverageMapPath: `${packageShadow}/out/init.cov-map.json`,
					instrumentedLuauPath: `${packageShadow}/out/init.luau`,
					originalLuauPath: fileKey,
					sourceHash: sha256(sourceContent),
					sourceMapPath: `${packageShadow}/out/init.luau.map`,
					statementCount: 1,
				},
			},
			generatedAt: "2025-01-01T00:00:00.000Z",
			instrumenterVersion: INSTRUMENTER_VERSION,
			luauRoots: [`${packageShadow}/out`],
			nonInstrumentedFiles: {},
			shadowDir: packageShadow,
			version: MANIFEST_VERSION,
		};

		vol.fromJSON({
			[`${packageShadow}/out/init.cov-map.json`]: "{}",
			// Cache hit requires the shadow outputs the manifest points at
			// to still exist on disk (otherwise computeSkipFiles drops the
			// record and forces re-instrumentation).
			[`${packageShadow}/out/init.luau`]: "instrumented",
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Pkg: { $path: "out" } },
				},
			}),
			[path.join(FOO_DIR, "out/init.luau")]: sourceContent,
			[path.join(
				WORKSPACE_ROOT,
				".jest-roblox/workspace/@halcyon-foo/coverage/coverage-manifest.json",
			)]: JSON.stringify(previousManifest),
		});
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
	});

	// Codex review follow-up: syncNonInstrumentedFiles reused a
	// previousRecord whenever the source hash matched, without verifying
	// that `record.shadowPath` still existed. A partial cleanup would let
	// the manifest claim a spec was cached while the shadow file was gone.
	// Validate by re-copying when the shadow file is missing.
	it("should re-copy non-instrumented file when its shadow is missing", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const helperContent = "local x = 1";
		const specContent = "return {}";
		const absoluteSourceRoot = path.join(FOO_DIR, "out-test").replaceAll("\\", "/");
		const helperKey = `${absoluteSourceRoot}/test/fixtures.luau`;
		const specKey = `${absoluteSourceRoot}/src/foo.spec.luau`;
		const packageShadow = path
			.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage")
			.replaceAll("\\", "/");
		const shadowSpecPath = `${packageShadow}/out-test/src/foo.spec.luau`;
		const previousManifest: CoverageManifest = {
			buildId: "prev-build-id",
			files: {
				[helperKey]: {
					key: helperKey,
					coverageMapPath: `${packageShadow}/out-test/test/fixtures.cov-map.json`,
					instrumentedLuauPath: `${packageShadow}/out-test/test/fixtures.luau`,
					originalLuauPath: helperKey,
					sourceHash: sha256(helperContent),
					sourceMapPath: `${packageShadow}/out-test/test/fixtures.luau.map`,
					statementCount: 1,
				},
			},
			generatedAt: "2025-01-01T00:00:00.000Z",
			instrumenterVersion: INSTRUMENTER_VERSION,
			luauRoots: [`${packageShadow}/out-test`],
			nonInstrumentedFiles: {
				[specKey]: {
					shadowPath: shadowSpecPath,
					sourceHash: sha256(specContent),
					sourcePath: specKey,
				},
			},
			shadowDir: packageShadow,
			version: MANIFEST_VERSION,
		};

		vol.fromJSON({
			[`${packageShadow}/out-test/test/fixtures.cov-map.json`]: "{}",
			// Cached helper shadow files exist (so instrumentation is skipped
			// for the helper) — but the spec's shadow file does NOT exist.
			[`${packageShadow}/out-test/test/fixtures.luau`]: "instrumented",
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Tests: { $path: "out-test" } },
				},
			}),
			[path.join(FOO_DIR, "out-test/src/foo.spec.luau")]: specContent,
			[path.join(FOO_DIR, "out-test/test/fixtures.luau")]: helperContent,
			[path.join(
				WORKSPACE_ROOT,
				".jest-roblox/workspace/@halcyon-foo/coverage/coverage-manifest.json",
			)]: JSON.stringify(previousManifest),
		});
		await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		// previousRecord matched the source hash but pointed at a missing
		// shadow file — re-copy via copyFileSync so the shadow stays
		// consistent with the manifest.
		expect(vol.existsSync(shadowSpecPath)).toBeTrue();
	});

	// Symmetry with prepareCoverage: each non-instrumented file the
	// shadow inherits via cpSync (spec/test/snap luau) needs a record in
	// the manifest so a future incremental run can detect stale shadow
	// entries and prune them.
	it("should track non-instrumented files (spec/test/snap) in the per-package manifest", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Tests: { $path: "out-test" } },
				},
			}),
			[path.join(FOO_DIR, "out-test/src/foo.spec.luau")]: "return {}",
			[path.join(FOO_DIR, "out-test/test/fixtures.luau")]: "local x = 1",
		});
		await mockInstrumentRoot();

		const [result] = prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		const manifest = manifestSchema.assert(
			JSON.parse(vol.readFileSync(result!.manifestPath, "utf-8") as string),
		);
		const specKey = `${path.join(FOO_DIR, "out-test").replaceAll("\\", "/")}/src/foo.spec.luau`;

		expect(Object.keys(manifest.nonInstrumentedFiles)).toContain(specKey);
	});

	it("should skip $path entries that escape the package directory", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		// $path: "../bar" resolves to the SIBLING package, outside FOO_DIR.
		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Escape: { $path: "../bar" } },
				},
			}),
			[path.join(BAR_DIR, "init.luau")]: "local x = 1",
		});
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
	});

	it("should skip $path entries that do not exist on disk", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Missing: { $path: "does-not-exist" } },
				},
			}),
		});
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
	});

	it("should skip $path entries matching coveragePathIgnorePatterns", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		seedPackage(FOO_DIR, {
			luauRoots: ["node_modules"],
			rojoTree: {
				$className: "DataModel",
				ReplicatedStorage: { Vendor: { $path: "node_modules" } },
			},
		});
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
	});

	it("should skip $path entries that resolve to files (not directories)", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Single: { $path: "init.luau" } },
				},
			}),
			[path.join(FOO_DIR, "init.luau")]: "local x = 1",
		});
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
	});

	it("should skip directories that contain no .luau files", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Empty: { $path: "vendor" } },
				},
			}),
			[path.join(FOO_DIR, "vendor/readme.txt")]: "",
			[path.join(FOO_DIR, "vendor/sub/data.json")]: "{}",
		});
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
	});

	it("should skip directories that only contain spec / test / snap luau files", async () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Tests: { $path: "out-test" } },
				},
			}),
			[path.join(FOO_DIR, "out-test/__snapshots__/foo.spec.snap.luau")]: "",
			[path.join(FOO_DIR, "out-test/src/bar.test.luau")]: "",
			[path.join(FOO_DIR, "out-test/src/foo.spec.luau")]: "",
		});
		const mocked = await mockInstrumentRoot();

		const result = prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		// `out-test/` only contains files the instrumenter would skip
		// (`.spec.luau`, `.test.luau`, `.snap.luau` — see `parse-ast.luau`).
		// Without filtering them at discovery time, the synthesizer would swap
		// the parent's `$path` to an empty shadow dir and the demote pass
		// inside `walkToLeaf` would fail to find any siblings on disk.
		expect(mocked).not.toHaveBeenCalled();
		expect(result[0]?.coverageRoots).toStrictEqual([]);
	});

	// When a $path tree mixes spec files with non-spec helpers
	// (e.g. flux-react's `out-test/` holds `test/fixtures.luau` next to
	// `src/foo.spec.luau`), `containsLuauFiles` makes the dir a coverage
	// root because the helper passes `isInstrumentableLuauFile`. The
	// synthesizer then redirects `$path` to the shadow, which only holds
	// the instrumented helper — the spec disappears. The fix: bulk-copy
	// the source tree into the shadow (matching prepareCoverage's
	// behavior) so spec files survive the redirect.
	it("should preserve spec files in the shadow when $path mixes specs with non-spec helpers", async () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Tests: { $path: "out-test" } },
				},
			}),
			[path.join(FOO_DIR, "out-test/src/foo.spec.luau")]: "return {}",
			[path.join(FOO_DIR, "out-test/test/fixtures.luau")]: "local x = 1",
		});
		await mockInstrumentRoot();

		const result = prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(result[0]?.coverageRoots).toHaveLength(1);

		const { shadowDir } = result[0]!.coverageRoots[0]!;
		const specInShadow = path.join(shadowDir, "src/foo.spec.luau").replaceAll("\\", "/");

		expect(vol.existsSync(specInShadow)).toBeTrue();
	});

	// Regression: roblox-ts ships its vendor runtime (`RuntimeLib.lua`,
	// `Promise.lua`) into the project's rbxts `include/` dir. Instrumenting
	// those files isn't useful (they're vendor code, not project source) and
	// the synthesizer would then redirect `rbxts_include.$path` to the shadow,
	// adding probe overhead to every `require` through `TS.import`. Skip any
	// `$path` whose root contains a `RuntimeLib` file — the canonical marker.
	it("should skip directories containing RuntimeLib (rbxts include)", async () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						Pkg: { $path: "out" },
						rbxts_include: { $path: "include" },
					},
				},
			}),
			[path.join(FOO_DIR, "include/Promise.lua")]: "local x = 1",
			[path.join(FOO_DIR, "include/RuntimeLib.lua")]: "local x = 1",
			[path.join(FOO_DIR, "out/init.luau")]: "local x = 1",
		});
		const mocked = await mockInstrumentRoot();

		const result = prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).toHaveBeenCalledOnce();
		expect(result[0]?.coverageRoots).toStrictEqual([
			{
				luauRoot: "out",
				shadowDir: path
					.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out")
					.replaceAll("\\", "/"),
			},
		]);
	});

	it("should dedupe duplicate $path entries within a single package", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { A: { $path: "src" }, B: { $path: "src" } },
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "local x = 1",
		});
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).toHaveBeenCalledOnce();
	});

	it("should treat an empty coveragePathIgnorePatterns list as ignoring nothing", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		seedPackage(FOO_DIR);
		const mocked = await mockInstrumentRoot();

		prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).toHaveBeenCalledOnce();
	});

	it("should skip packages whose rojo tree has no instrumentable luau roots", async () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		// Package whose tree has no $path entries → nothing to instrument
		vol.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: { $className: "DataModel" },
			}),
		});
		const mocked = await mockInstrumentRoot();

		const result = prepareWorkspaceCoverage({
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
		expect(result[0]?.coverageRoots).toStrictEqual([]);
	});

	// Workspace coverage walked every rojo `$path` mount and
	// instrumented every directory containing luau files — ignoring per-pkg
	// `luauRoots` and `coveragePathIgnorePatterns` that single mode honors. The
	// fix threads both knobs through `WorkspacePackageDescriptor`. These cases
	// seed a multi-mount rojo tree (the user-owned `src/` + a vendored
	// `vendored-packages/`) and pin the new descriptor fields' semantics.
	describe("multi-$path rojo tree with per-pkg descriptor fields", () => {
		const multiMountTree = {
			$className: "DataModel",
			ReplicatedStorage: {
				Packages: { $path: "vendored-packages" },
				Src: { $path: "src" },
			},
		};

		function seedMultiMount(): void {
			vol.fromJSON({
				[FOO_PROJECT]: JSON.stringify({
					name: "foo-test",
					tree: multiMountTree,
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "local x = 1",
				[path.join(FOO_DIR, "vendored-packages/dep/init.luau")]: "local y = 2",
			});
		}

		it("should short-circuit to descriptor.luauRoots when set, ignoring other rojo $path mounts", async () => {
			expect.assertions(3);

			onTestFinished(() => {
				vol.reset();
			});

			seedMultiMount();
			const mocked = await mockInstrumentRoot();

			const [result] = prepareWorkspaceCoverage({
				packages: [
					{
						name: "@halcyon/foo",
						luauRoots: ["src"],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(mocked).toHaveBeenCalledOnce();
			expect(result?.coverageRoots.map((entry) => entry.luauRoot)).toStrictEqual(["src"]);

			const manifest = manifestSchema.assert(
				JSON.parse(vol.readFileSync(result!.manifestPath, "utf-8") as string),
			);

			expect(manifest.luauRoots).toHaveLength(1);
		});

		it("should preserve existing behavior (walk every $path) when descriptor.luauRoots is undefined", async () => {
			expect.assertions(2);

			onTestFinished(() => {
				vol.reset();
			});

			seedMultiMount();
			const mocked = await mockInstrumentRoot();

			const [result] = prepareWorkspaceCoverage({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(mocked).toHaveBeenCalledTimes(2);
			expect(result?.coverageRoots.map((entry) => entry.luauRoot).sort()).toStrictEqual([
				"src",
				"vendored-packages",
			]);
		});

		it("should drop off-tree luauRoot entries with a stderr warning", async () => {
			expect.assertions(3);

			onTestFinished(() => {
				vol.reset();
			});

			seedMultiMount();
			const mocked = await mockInstrumentRoot();
			const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

			const [result] = prepareWorkspaceCoverage({
				packages: [
					{
						name: "@halcyon/foo",
						luauRoots: ["build/out"],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(mocked).not.toHaveBeenCalled();
			expect(result?.coverageRoots).toStrictEqual([]);

			const warnings = writeSpy.mock.calls.map(([chunk]) => String(chunk));

			expect(
				warnings.some(
					(line) =>
						line.includes('luauRoot "build/out"') && line.includes("@halcyon/foo"),
				),
			).toBeTrue();
		});

		it("should fall through to the rojo walk when descriptor.luauRoots is an empty array", async () => {
			expect.assertions(1);

			onTestFinished(() => {
				vol.reset();
			});

			seedMultiMount();
			const mocked = await mockInstrumentRoot();

			prepareWorkspaceCoverage({
				packages: [
					{
						name: "@halcyon/foo",
						luauRoots: [],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			// `[]` means auto-detect (matches single mode's `> 0` gate at
			// prepare.ts:187). Both mounts get instrumented.
			expect(mocked).toHaveBeenCalledTimes(2);
		});

		it("should ignore workspace-root coveragePathIgnorePatterns and inherit DEFAULT_CONFIG when descriptor field is undefined", async () => {
			expect.assertions(2);

			onTestFinished(() => {
				vol.reset();
			});

			// Workspace-mode reads ignore patterns from each
			// package's own config (or DEFAULT_CONFIG when omitted) — not
			// from a workspace-root jest.config. The descriptor has no
			// per-pkg override here, so the workspace-root custom value
			// below must be ignored and both rojo mounts instrumented.
			seedMultiMount();
			const mocked = await mockInstrumentRoot();

			const [result] = prepareWorkspaceCoverage({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(mocked).toHaveBeenCalledTimes(2);
			expect(result?.coverageRoots.map((entry) => entry.luauRoot).sort()).toStrictEqual([
				"src",
				"vendored-packages",
			]);
		});

		it("should honor per-pkg coveragePathIgnorePatterns over the DEFAULT_CONFIG fallback", async () => {
			expect.assertions(2);

			onTestFinished(() => {
				vol.reset();
			});

			seedMultiMount();
			const mocked = await mockInstrumentRoot();

			const [result] = prepareWorkspaceCoverage({
				packages: [
					{
						name: "@halcyon/foo",
						coveragePathIgnorePatterns: ["**/vendored-packages/**"],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(mocked).toHaveBeenCalledOnce();
			expect(result?.coverageRoots.map((entry) => entry.luauRoot)).toStrictEqual(["src"]);
		});

		it("should instrument every mount when the descriptor opts out of every pattern via an empty array", async () => {
			expect.assertions(2);

			onTestFinished(() => {
				vol.reset();
			});

			// Per-pkg `coveragePathIgnorePatterns: []` means "no ignore
			// patterns" — even DEFAULT_CONFIG's defaults don't apply, so a
			// directory named like a spec/test mount would still be
			// instrumented. The empty-patterns branch of `createIgnoreMatcher`
			// has no other caller after the workspace-root drop.
			seedMultiMount();
			const mocked = await mockInstrumentRoot();

			const [result] = prepareWorkspaceCoverage({
				packages: [
					{
						name: "@halcyon/foo",
						coveragePathIgnorePatterns: [],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(mocked).toHaveBeenCalledTimes(2);
			expect(result?.coverageRoots.map((entry) => entry.luauRoot).sort()).toStrictEqual([
				"src",
				"vendored-packages",
			]);
		});

		it("should accept luauRoots nested inside a $path mount", async () => {
			expect.assertions(2);

			onTestFinished(() => {
				vol.reset();
			});

			// rojo mounts `src` at the parent level; the package opts into a
			// narrower `luauRoot` underneath it. Exercises the
			// `candidate.startsWith(mount/)` branch of `isOnRojoTree`.
			vol.fromJSON({
				[FOO_PROJECT]: JSON.stringify({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { Src: { $path: "src" } },
					},
				}),
				[path.join(FOO_DIR, "src/client/init.luau")]: "local x = 1",
			});
			const mocked = await mockInstrumentRoot();

			const [result] = prepareWorkspaceCoverage({
				packages: [
					{
						name: "@halcyon/foo",
						luauRoots: ["src/client"],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(mocked).toHaveBeenCalledOnce();
			expect(result?.coverageRoots.map((entry) => entry.luauRoot)).toStrictEqual([
				"src/client",
			]);
		});

		it("should accept a luauRoot that contains a finer-grained $path mount", async () => {
			expect.assertions(2);

			onTestFinished(() => {
				vol.reset();
			});

			// rojo mounts `src/client` only; the package opts into the
			// broader `src` as its luauRoot. Exercises the
			// `mount.startsWith(candidate/)` branch of `isOnRojoTree`.
			vol.fromJSON({
				[FOO_PROJECT]: JSON.stringify({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { Client: { $path: "src/client" } },
					},
				}),
				[path.join(FOO_DIR, "src/client/init.luau")]: "local y = 2",
				[path.join(FOO_DIR, "src/init.luau")]: "local x = 1",
			});
			const mocked = await mockInstrumentRoot();

			const [result] = prepareWorkspaceCoverage({
				packages: [
					{
						name: "@halcyon/foo",
						luauRoots: ["src"],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(mocked).toHaveBeenCalledOnce();
			expect(result?.coverageRoots.map((entry) => entry.luauRoot)).toStrictEqual(["src"]);
		});

		it("should deduplicate repeated luauRoots entries", async () => {
			expect.assertions(2);

			onTestFinished(() => {
				vol.reset();
			});

			seedMultiMount();
			const mocked = await mockInstrumentRoot();

			const [result] = prepareWorkspaceCoverage({
				packages: [
					{
						name: "@halcyon/foo",
						luauRoots: ["src", "src"],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(mocked).toHaveBeenCalledOnce();
			expect(result?.coverageRoots.map((entry) => entry.luauRoot)).toStrictEqual(["src"]);
		});

		it("should skip a luauRoot that is on the rojo tree but has no instrumentable files", async () => {
			expect.assertions(2);

			onTestFinished(() => {
				vol.reset();
			});

			// rojo mounts `src` (with content) and `empty` (no luau files).
			// `empty` is on-tree per `isOnRojoTree` but `containsLuauFiles`
			// returns false; `isInstrumentableRoot` drops it.
			vol.fromJSON({
				[FOO_PROJECT]: JSON.stringify({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							Empty: { $path: "empty" },
							Src: { $path: "src" },
						},
					},
				}),
				[path.join(FOO_DIR, "empty/README.md")]: "not a luau file",
				[path.join(FOO_DIR, "src/init.luau")]: "local x = 1",
			});
			const mocked = await mockInstrumentRoot();

			const [result] = prepareWorkspaceCoverage({
				packages: [
					{
						name: "@halcyon/foo",
						luauRoots: ["empty", "src"],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(mocked).toHaveBeenCalledOnce();
			expect(result?.coverageRoots.map((entry) => entry.luauRoot)).toStrictEqual(["src"]);
		});

		it("should cold-rebuild the shadow when luauRoots shrinks between runs", async () => {
			expect.assertions(2);

			onTestFinished(() => {
				vol.reset();
			});

			const packageShadow = path
				.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage")
				.replaceAll("\\", "/");
			const staleVendoredShadow = path.join(packageShadow, "vendored-packages/dep/init.luau");
			const sourceFileKey = `${path.join(FOO_DIR, "src").replaceAll("\\", "/")}/init.luau`;
			const vendoredShadowDirectory = path.join(packageShadow, "vendored-packages");
			const previousManifest: CoverageManifest = {
				buildId: "prev-build-id",
				files: {
					[sourceFileKey]: {
						key: sourceFileKey,
						coverageMapPath: `${sourceFileKey}.cov-map.json`,
						instrumentedLuauPath: sourceFileKey,
						originalLuauPath: sourceFileKey,
						sourceHash: sha256("local x = 1"),
						sourceMapPath: `${sourceFileKey}.map`,
						statementCount: 1,
					},
				},
				generatedAt: new Date().toISOString(),
				instrumenterVersion: INSTRUMENTER_VERSION,
				// Prior run instrumented BOTH mounts; the new run only lists
				// `src`.
				luauRoots: [
					path.join(packageShadow, "src").replaceAll("\\", "/"),
					path.join(packageShadow, "vendored-packages").replaceAll("\\", "/"),
				],
				nonInstrumentedFiles: {},
				shadowDir: packageShadow,
				version: MANIFEST_VERSION,
			};

			vol.fromJSON({
				[FOO_PROJECT]: JSON.stringify({ name: "foo-test", tree: multiMountTree }),
				[path.join(FOO_DIR, "src/init.luau")]: "local x = 1",
				[path.join(FOO_DIR, "vendored-packages/dep/init.luau")]: "local y = 2",
				[path.join(packageShadow, "coverage-manifest.json")]:
					JSON.stringify(previousManifest),
				// Stale shadow file from the prior mount that the new run drops.
				[staleVendoredShadow]: "return {}",
			});
			await mockInstrumentRoot();

			prepareWorkspaceCoverage({
				packages: [
					{
						name: "@halcyon/foo",
						luauRoots: ["src"],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(vol.existsSync(staleVendoredShadow)).toBeFalse();
			expect(vol.existsSync(vendoredShadowDirectory)).toBeFalse();
		});

		it("should cold-rebuild when luauRoots size matches but membership changes", async () => {
			expect.assertions(1);

			onTestFinished(() => {
				vol.reset();
			});

			// Same cardinality, different members: prior manifest tracked
			// `vendored-packages` but the new luauRoot is `src`. Exercises the
			// `setsEqual` value-mismatch branch (size equal, content differs).
			const packageShadow = path
				.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage")
				.replaceAll("\\", "/");
			const staleVendoredShadow = path.join(packageShadow, "vendored-packages/dep/init.luau");
			const previousFileKey = `${path.join(FOO_DIR, "vendored-packages").replaceAll("\\", "/")}/dep/init.luau`;
			const previousManifest: CoverageManifest = {
				buildId: "prev-build-id",
				files: {
					[previousFileKey]: {
						key: previousFileKey,
						coverageMapPath: `${previousFileKey}.cov-map.json`,
						instrumentedLuauPath: previousFileKey,
						originalLuauPath: previousFileKey,
						sourceHash: sha256("local y = 2"),
						sourceMapPath: `${previousFileKey}.map`,
						statementCount: 1,
					},
				},
				generatedAt: new Date().toISOString(),
				instrumenterVersion: INSTRUMENTER_VERSION,
				luauRoots: [path.join(packageShadow, "vendored-packages").replaceAll("\\", "/")],
				nonInstrumentedFiles: {},
				shadowDir: packageShadow,
				version: MANIFEST_VERSION,
			};

			vol.fromJSON({
				[FOO_PROJECT]: JSON.stringify({ name: "foo-test", tree: multiMountTree }),
				[path.join(FOO_DIR, "src/init.luau")]: "local x = 1",
				[path.join(FOO_DIR, "vendored-packages/dep/init.luau")]: "local y = 2",
				[path.join(packageShadow, "coverage-manifest.json")]:
					JSON.stringify(previousManifest),
				[staleVendoredShadow]: "return {}",
			});
			await mockInstrumentRoot();

			prepareWorkspaceCoverage({
				packages: [
					{
						name: "@halcyon/foo",
						luauRoots: ["src"],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(vol.existsSync(staleVendoredShadow)).toBeFalse();
		});

		it("should preserve the cache when luauRoots is unchanged between runs", async () => {
			expect.assertions(1);

			onTestFinished(() => {
				vol.reset();
			});

			// Cache hit with matching luauRoots set: prior shadow survives and
			// `useIncremental` stays `true`. Exercises the
			// `setsEqual === true` branch.
			const packageShadow = path
				.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage")
				.replaceAll("\\", "/");
			const fileKey = `${path.join(FOO_DIR, "out").replaceAll("\\", "/")}/init.luau`;
			const previousManifest: CoverageManifest = {
				buildId: "prev-build-id",
				files: {
					[fileKey]: {
						key: fileKey,
						coverageMapPath: `${fileKey}.cov-map.json`,
						instrumentedLuauPath: fileKey,
						originalLuauPath: fileKey,
						sourceHash: sha256("local x = 1"),
						sourceMapPath: `${fileKey}.map`,
						statementCount: 1,
					},
				},
				generatedAt: new Date().toISOString(),
				instrumenterVersion: INSTRUMENTER_VERSION,
				luauRoots: [path.join(packageShadow, "out").replaceAll("\\", "/")],
				nonInstrumentedFiles: {},
				shadowDir: packageShadow,
				version: MANIFEST_VERSION,
			};

			seedPackage(FOO_DIR);
			vol.fromJSON({
				[path.join(packageShadow, "coverage-manifest.json")]:
					JSON.stringify(previousManifest),
				[path.join(packageShadow, "out/preserved.txt")]: "cache-survives",
			});
			await mockInstrumentRoot();

			prepareWorkspaceCoverage({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			// Cache preserved → rmSync did not fire, the marker is still there.
			expect(vol.existsSync(path.join(packageShadow, "out/preserved.txt"))).toBeTrue();
		});

		it("should skip rojo $path entries that escape the package directory", async () => {
			expect.assertions(2);

			onTestFinished(() => {
				vol.reset();
			});

			// `..` path escapes the package — the relative path starts with
			// "..", which `buildRojoMountSet` drops. Combined with a per-pkg
			// `luauRoots` that lists the absolute-equivalent root, this
			// confirms the off-tree filter and the warning fire.
			vol.fromJSON({
				[FOO_PROJECT]: JSON.stringify({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { External: { $path: "../sibling" } },
					},
				}),
				[path.join(WORKSPACE_ROOT, "sibling/init.luau")]: "local x = 1",
			});
			await mockInstrumentRoot();
			const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

			const [result] = prepareWorkspaceCoverage({
				packages: [
					{
						name: "@halcyon/foo",
						luauRoots: ["sibling"],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(result?.coverageRoots).toStrictEqual([]);
			expect(writeSpy).toHaveBeenCalledWith(
				expect.stringContaining('luauRoot "sibling" in @halcyon/foo'),
			);
		});
	});
});
