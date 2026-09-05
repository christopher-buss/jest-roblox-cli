import * as crypto from "node:crypto";
import * as path from "node:path";
import process from "node:process";
import type { MockedFunction } from "vitest";
import { describe, expect, it, vi } from "vitest";

import type { MemoryVolume } from "../../test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath, toPosixRoot } from "../utils/normalize-windows-path.ts";
import type { BuildManifest, BuildManifestArtifact } from "./build-manifest.ts";
import { buildManifestSchema } from "./build-manifest.ts";
import { hashCopyIgnorePatterns } from "./discover-files.ts";
import { INSTRUMENTER_VERSION } from "./instrumenter.ts";
import type { CoverageManifest, InstrumentedFileRecord } from "./manifest.ts";
import { MANIFEST_VERSION, manifestSchema } from "./manifest.ts";
import { emitWorkspaceBuildManifests, prepareWorkspaceCoverage } from "./workspace-prepare.ts";

/**
 * Matches the warning emitted for `@halcyon/foo`'s missing `build/out` root.
 * Hoisted to module scope so the two-clause predicate isn't a conditional
 * inside a test body.
 */
function mentionsMissingFooRoot(line: string): boolean {
	return line.includes('luauRoot "build/out"') && line.includes("@halcyon/foo");
}

function sha256(content: string): string {
	return crypto.createHash("sha256").update(content).digest("hex");
}

function isoNow(): string {
	const now = new Date();
	return now.toISOString();
}

vi.mock(import("./instrumenter"));

const DEFAULT_COPY_IGNORE_HASH = hashCopyIgnorePatterns(DEFAULT_CONFIG.coverageCopyIgnorePatterns);

const WORKSPACE_ROOT = path.resolve("/repo");
const FOO_DIR = path.join(WORKSPACE_ROOT, "packages/foo");
const BAR_DIR = path.join(WORKSPACE_ROOT, "packages/bar");
const FOO_PROJECT = path.join(FOO_DIR, "test.project.json");
const BAR_PROJECT = path.join(BAR_DIR, "test.project.json");
const SHARED_PLACE: BuildManifestArtifact = { hash: "place-hash", path: "synthesized.rbxl" };

interface SeedOptions {
	luauRoots?: Array<string>;
	rojoTree?: object;
}

function seedPackage(
	volume: MemoryVolume,
	packageDirectory: string,
	{
		luauRoots = ["out"],
		rojoTree = {
			$className: "DataModel",
			ReplicatedStorage: { Pkg: { $path: "out" } },
		},
	}: SeedOptions = {},
): void {
	volume.fromJSON({
		[path.join(packageDirectory, "test.project.json")]: JSON.stringify({
			name: "pkg-test",
			tree: rojoTree,
		}),
	});
	for (const luauRoot of luauRoots) {
		volume.mkdirSync(path.join(packageDirectory, luauRoot), { recursive: true });
		volume.writeFileSync(path.join(packageDirectory, luauRoot, "init.luau"), "local x = 1");
	}
}

async function mockInstrumentRootAsync(
	implementation?: (options: {
		luauRoot: string;
		shadowDir: string;
	}) => Record<string, InstrumentedFileRecord>,
): Promise<MockedFunction<typeof import("./instrumenter.ts").instrumentRoot>> {
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
	// Both cases site the package away from the invocation directory: the
	// package's globs are written relative to its own `rootDir`, so nothing
	// about where the CLI was run may decide what they name. The implicit case
	// is the common one; the explicit case is a package that points `rootDir`
	// elsewhere, and the report reads back the same anchor.
	it.for([
		{ anchor: "its own directory", glob: "out/init.luau", rootDir: undefined },
		{
			anchor: "an explicit rootDir",
			glob: "packages/foo/out/init.luau",
			rootDir: WORKSPACE_ROOT,
		},
	])(
		"should narrow instrumentation to collectCoverageFrom anchored at $anchor",
		async ({ glob, rootDir }) => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			seedPackage(volume, FOO_DIR);
			volume.mkdirSync(path.join(FOO_DIR, "out/ui"), { recursive: true });
			volume.writeFileSync(path.join(FOO_DIR, "out/ui/button.luau"), "local y = 2");
			const mocked = await mockInstrumentRootAsync();

			const result = prepareWorkspaceCoverage({
				fileSystem,
				packages: [
					{
						name: "@halcyon/foo",
						collectCoverageFrom: [glob],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
						rootDir,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(mocked.mock.calls[0]![0].skipFiles).toStrictEqual(new Set(["ui/button.luau"]));
			expect(result[0]!.manifest.coverageUniverseHash).toMatch(/^[a-f0-9]{64}$/);
		},
	);

	it("should leave a root the universe never touches out of the coverage roots", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, FOO_DIR, {
			luauRoots: ["out", "vendor"],
			rojoTree: {
				$className: "DataModel",
				ReplicatedStorage: { Pkg: { $path: "out" }, Vendor: { $path: "vendor" } },
			},
		});
		await mockInstrumentRootAsync();

		const [result] = prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{
					name: "@halcyon/foo",
					collectCoverageFrom: ["out/init.luau"],
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		// Only `out` earns a redirect; `vendor` keeps its original mount, which
		// serves exactly the bytes a shadow of it would have.
		expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual(["out"]);
	});

	it("should instrument the whole package when it names no coverage globs", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, FOO_DIR);
		const mocked = await mockInstrumentRootAsync();

		const result = prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked.mock.calls[0]![0].skipFiles).toBeUndefined();
		expect(result[0]!.manifest.coverageUniverseHash).toBeUndefined();
	});

	it("should return per-package coverage roots whose luauRoot is package-relative and shadowDir is absolute", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, FOO_DIR);
		await mockInstrumentRootAsync();

		const result = prepareWorkspaceCoverage({
			fileSystem,
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
		expect(result[0]!.coverageRoots).toStrictEqual([
			{
				luauRoot: toPosixRoot("out"),
				shadowDir: path
					.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out")
					.replaceAll("\\", "/"),
			},
		]);
	});

	it("should write a per-package manifest at workspace-root-scoped path", async () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, FOO_DIR);
		await mockInstrumentRootAsync();

		const result = prepareWorkspaceCoverage({
			fileSystem,
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

		expect(result[0]!.manifestPath).toBe(expectedPath.replaceAll("\\", "/"));
		expect(volume.existsSync(expectedPath)).toBeTrue();
		expect(volume.readFileSync(expectedPath, "utf8")).toContain('\n\t"buildId":');
	});

	it("should call instrumentRoot once per discovered luau root in each package", async () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, FOO_DIR, {
			luauRoots: ["out/client", "out/server"],
			rojoTree: {
				$className: "DataModel",
				ReplicatedStorage: { Client: { $path: "out/client" } },
				ServerScriptService: { Server: { $path: "out/server" } },
			},
		});
		const mocked = await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
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

		const luauRoots = mocked.mock.calls.map(([options]): string => options.luauRoot);

		expect(luauRoots).toContain(path.join(FOO_DIR, "out/client").replaceAll("\\", "/"));
		expect(luauRoots).toContain(path.join(FOO_DIR, "out/server").replaceAll("\\", "/"));
	});

	it("should isolate shadow dirs and manifests between packages", async () => {
		expect.assertions(4);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, FOO_DIR);
		seedPackage(volume, BAR_DIR);
		await mockInstrumentRootAsync();

		const result = prepareWorkspaceCoverage({
			fileSystem,
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

		expect(result.find((entry) => entry.pkg === "@halcyon/foo")!.manifestPath).toBe(
			fooManifest.replaceAll("\\", "/"),
		);
		expect(result.find((entry) => entry.pkg === "@halcyon/bar")!.manifestPath).toBe(
			barManifest.replaceAll("\\", "/"),
		);
		expect(volume.existsSync(fooManifest)).toBeTrue();
		expect(volume.existsSync(barManifest)).toBeTrue();
	});

	it("should aggregate instrumented file records into the per-package manifest", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, FOO_DIR);
		await mockInstrumentRootAsync();

		const [result] = prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		const manifest = manifestSchema.assert(
			JSON.parse(volume.readFileSync(result!.manifestPath, "utf-8").toString()),
		);
		const expectedKey = `${path.join(FOO_DIR, "out").replaceAll("\\", "/")}/init.luau`;

		expect(Object.keys(manifest.files)).toContain(expectedKey);
	});

	// Codex review follow-up: a cold run only ever adds to the package shadow —
	// the instrumenter and the mirror sync both merge, and the reconcile that
	// deletes runs warm. If a prior run wrote files that have since been deleted
	// from source — or the cache is invalid / version-stale and we fall back to
	// a cold run — those stale files survive into the redirected $path mount.
	// Single-package prepares avoid this by rmSync-ing COVERAGE_DIR before
	// instrumenting; workspace must nuke its own per-package shadow root for
	// symmetry.
	it("should remove stale shadow files when running cold (no cache)", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		const packageShadow = path
			.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage")
			.replaceAll("\\", "/");
		const staleSpecPath = path.join(packageShadow, "out/stale.spec.luau");

		volume.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Pkg: { $path: "out" } },
				},
			}),
			[path.join(FOO_DIR, "out/init.luau")]: "local x = 1",
			[path.join(FOO_DIR, "out/live.spec.luau")]: "return {}",
			// Stale spec from a prior run — source has no matching file.
			[staleSpecPath]: "return {}",
		});
		await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		// Stale shadow file gone — rmSync of the package shadow before the run
		// writes anything into it.
		expect(volume.existsSync(staleSpecPath)).toBeFalse();
		// Current source still landed, through the mirror sync.
		expect(volume.existsSync(path.join(packageShadow, "out/live.spec.luau"))).toBeTrue();
	});

	it("should bypass a full cache hit when the descriptor opts out via per-pkg coverageCache", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
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
			copyIgnoreHash: DEFAULT_COPY_IGNORE_HASH,
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

		volume.fromJSON({
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
		const mocked = await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
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

	it("should discard a manifest whose coverage universe no longer matches", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		const sourceContent = "local x = 1";
		const fileKey = `${path.join(FOO_DIR, "out").replaceAll("\\", "/")}/init.luau`;
		const previousManifest: CoverageManifest = {
			buildId: "prev-build-id",
			copyIgnoreHash: DEFAULT_COPY_IGNORE_HASH,
			coverageUniverseHash: "a-different-universe",
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
			instrumenterVersion: INSTRUMENTER_VERSION,
			luauRoots: [],
			nonInstrumentedFiles: {},
			shadowDir: "x",
			version: MANIFEST_VERSION,
		};

		seedPackage(volume, FOO_DIR);
		volume.fromJSON({
			[path.join(
				WORKSPACE_ROOT,
				".jest-roblox/workspace/@halcyon-foo/coverage/coverage-manifest.json",
			)]: JSON.stringify(previousManifest),
		});
		const mocked = await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{
					name: "@halcyon/foo",
					collectCoverageFrom: ["out/**"],
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		// A cold run carries nothing forward, so it passes no skip list.
		expect(mocked.mock.calls[0]![0].skipFiles).toBeUndefined();
	});

	it("should discard a manifest with a stale instrumenter version", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		const sourceContent = "local x = 1";
		const fileKey = `${path.join(FOO_DIR, "out").replaceAll("\\", "/")}/init.luau`;
		const previousManifest: CoverageManifest = {
			buildId: "prev-build-id",
			copyIgnoreHash: DEFAULT_COPY_IGNORE_HASH,
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

		volume.fromJSON({
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
		const mocked = await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
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

		const { fileSystem, volume } = createMemoryFileSystem();
		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		seedPackage(volume, FOO_DIR);
		const manifestDirectory = path.join(
			WORKSPACE_ROOT,
			".jest-roblox/workspace/@halcyon-foo/coverage",
		);
		volume.mkdirSync(manifestDirectory, { recursive: true });
		volume.writeFileSync(path.join(manifestDirectory, "coverage-manifest.json"), body);
		const mocked = await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
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

		const { fileSystem, volume } = createMemoryFileSystem();
		const sourceContent = "local x = 1";
		const absoluteSourceRoot = path.join(FOO_DIR, "out").replaceAll("\\", "/");
		const fileKey = `${absoluteSourceRoot}/init.luau`;
		const packageShadow = path
			.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage")
			.replaceAll("\\", "/");
		const previousManifest: CoverageManifest = {
			buildId: "prev-build-id",
			copyIgnoreHash: DEFAULT_COPY_IGNORE_HASH,
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
		volume.fromJSON({
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
		const mocked = await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
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

		const { fileSystem, volume } = createMemoryFileSystem();
		const sourceContent = "local x = 1";
		const absoluteSourceRoot = path.join(FOO_DIR, "out").replaceAll("\\", "/");
		const fileKey = `${absoluteSourceRoot}/init.luau`;
		const packageShadow = path
			.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage")
			.replaceAll("\\", "/");
		const previousManifest: CoverageManifest = {
			buildId: "prev-build-id",
			copyIgnoreHash: DEFAULT_COPY_IGNORE_HASH,
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

		volume.fromJSON({
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
		const mocked = await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
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

		const { fileSystem, volume } = createMemoryFileSystem();
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
			copyIgnoreHash: DEFAULT_COPY_IGNORE_HASH,
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

		volume.fromJSON({
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
		await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		// previousRecord matched the source hash but pointed at a missing
		// shadow file — re-copy via copyFileSync so the shadow stays
		// consistent with the manifest.
		expect(volume.existsSync(shadowSpecPath)).toBeTrue();
	});

	// Symmetry with prepareCoverageAsync: each non-instrumented file the
	// shadow mirrors verbatim (spec/test/snap luau) needs a record in
	// the manifest so a future incremental run can detect stale shadow
	// entries and prune them.
	it("should track non-instrumented files (spec/test/snap) in the per-package manifest", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
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
		await mockInstrumentRootAsync();

		const [result] = prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		const manifest = manifestSchema.assert(
			JSON.parse(volume.readFileSync(result!.manifestPath, "utf-8").toString()),
		);
		const specKey = `${path.join(FOO_DIR, "out-test").replaceAll("\\", "/")}/src/foo.spec.luau`;

		expect(Object.keys(manifest.nonInstrumentedFiles)).toContain(specKey);
	});

	it("should skip $path entries that escape the package directory", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		// $path: "../bar" resolves to the SIBLING package, outside FOO_DIR.
		volume.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Escape: { $path: "../bar" } },
				},
			}),
			[path.join(BAR_DIR, "init.luau")]: "local x = 1",
		});
		const mocked = await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
	});

	it("should skip $path entries that do not exist on disk", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Missing: { $path: "does-not-exist" } },
				},
			}),
		});
		const mocked = await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
	});

	it("should skip $path entries matching coveragePathIgnorePatterns", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, FOO_DIR, {
			luauRoots: ["node_modules"],
			rojoTree: {
				$className: "DataModel",
				ReplicatedStorage: { Vendor: { $path: "node_modules" } },
			},
		});
		const mocked = await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
	});

	it("should skip $path entries that resolve to files (not directories)", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { Single: { $path: "init.luau" } },
				},
			}),
			[path.join(FOO_DIR, "init.luau")]: "local x = 1",
		});
		const mocked = await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
	});

	it("should skip directories that contain no .luau files", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
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
		const mocked = await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
	});

	it("should discover ordinary .lua files without treating unrelated files as Luau", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						Code: { $path: "lua-code" },
						Docs: { $path: "docs" },
					},
				},
			}),
			[path.join(FOO_DIR, "docs/module.txt")]: "not luau",
			[path.join(FOO_DIR, "lua-code/module.lua")]: "return {}",
		});
		const mocked = await mockInstrumentRootAsync();

		const [result] = prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				luauRoot: normalizeWindowsPath(path.join(FOO_DIR, "lua-code")),
			}),
		);
		expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual([
			"lua-code",
		]);
	});

	it("should skip directories that only contain spec / test / snap luau files", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
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
		const mocked = await mockInstrumentRootAsync();

		const result = prepareWorkspaceCoverage({
			fileSystem,
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
		expect(result[0]!.coverageRoots).toStrictEqual([]);
	});

	// When a $path tree mixes spec files with non-spec helpers
	// (e.g. flux-react's `out-test/` holds `test/fixtures.luau` next to
	// `src/foo.spec.luau`), `containsLuauFiles` makes the dir a coverage
	// root because the helper passes `isInstrumentableLuauFile`. The
	// synthesizer then redirects `$path` to the shadow, which only holds
	// the instrumented helper — the spec disappears. The fix: the mirror
	// sync carries every file the instrumenter never emits into the
	// shadow, so spec files survive the redirect.
	it("should preserve spec files in the shadow when $path mixes specs with non-spec helpers", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
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
		await mockInstrumentRootAsync();

		const result = prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(result[0]!.coverageRoots).toHaveLength(1);

		const { shadowDir } = result[0]!.coverageRoots[0]!;
		const specInShadow = path.join(shadowDir, "src/foo.spec.luau").replaceAll("\\", "/");

		expect(volume.existsSync(specInShadow)).toBeTrue();
	});

	// Regression: roblox-ts ships its vendor runtime (`RuntimeLib.lua`,
	// `Promise.lua`) into the project's rbxts `include/` dir. Instrumenting
	// those files isn't useful (they're vendor code, not project source) and
	// the synthesizer would then redirect `rbxts_include.$path` to the shadow,
	// adding probe overhead to every `require` through `TS.import`. Skip any
	// `$path` whose root contains a `RuntimeLib` file — the canonical marker.
	it("should skip directories containing RuntimeLib (rbxts include)", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
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
		const mocked = await mockInstrumentRootAsync();

		const result = prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).toHaveBeenCalledOnce();
		expect(result[0]!.coverageRoots).toStrictEqual([
			{
				luauRoot: toPosixRoot("out"),
				shadowDir: path
					.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out")
					.replaceAll("\\", "/"),
			},
		]);
	});

	it("should dedupe duplicate $path entries within a single package", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { A: { $path: "src" }, B: { $path: "src" } },
				},
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "local x = 1",
		});
		const mocked = await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).toHaveBeenCalledOnce();
	});

	it("should treat an empty coveragePathIgnorePatterns list as ignoring nothing", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, FOO_DIR);
		const mocked = await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).toHaveBeenCalledOnce();
	});

	it("should require explicit luauRoots to correspond to collected rojo mounts", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, FOO_DIR, { luauRoots: ["Stryker was here"] });
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const mocked = await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{
					name: "@halcyon/foo",
					luauRoots: ["Stryker was here"],
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
		expect(stderr).toHaveBeenCalledExactlyOnceWith(
			'Warning: luauRoot "Stryker was here" in @halcyon/foo does not correspond to any rojo $path mount, so it reports no coverage.\n',
		);
	});

	it("should reject package-root, parent, and unrelated paths as explicit rojo mounts", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		const outsideDirectory = path.join(WORKSPACE_ROOT, "outside");
		volume.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						Outside: { $path: outsideDirectory },
						Parent: { $path: "../bar" },
						Root: { $path: "." },
					},
				},
			}),
			[path.join(BAR_DIR, "init.luau")]: "return {}",
			[path.join(FOO_DIR, "init.luau")]: "return {}",
			[path.join(outsideDirectory, "init.luau")]: "return {}",
		});
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const mocked = await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{
					name: "@halcyon/foo",
					luauRoots: [".", "../bar", outsideDirectory],
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
		expect(stderr).toHaveBeenCalledTimes(3);
	});

	it("should not treat the package-root rojo path as a coverage root", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						Out: { $path: "out" },
						Root: { $path: "." },
					},
				},
			}),
			[path.join(FOO_DIR, "init.luau")]: "return {}",
			[path.join(FOO_DIR, "out/init.luau")]: "return {}",
		});
		const mocked = await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ luauRoot: normalizeWindowsPath(path.join(FOO_DIR, "out")) }),
		);
	});

	it("should apply ignore patterns within a mounted path", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, FOO_DIR, {
			luauRoots: ["out/generated"],
			rojoTree: {
				$className: "DataModel",
				ReplicatedStorage: { Generated: { $path: "out/generated" } },
			},
		});
		const mocked = await mockInstrumentRootAsync();

		prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{
					name: "@halcyon/foo",
					coveragePathIgnorePatterns: ["generated"],
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
	});

	it("should skip packages whose rojo tree has no instrumentable luau roots", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		// Package whose tree has no $path entries → nothing to instrument
		volume.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: { $className: "DataModel" },
			}),
		});
		const mocked = await mockInstrumentRootAsync();

		const result = prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		expect(mocked).not.toHaveBeenCalled();
		expect(result[0]!.coverageRoots).toStrictEqual([]);
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

		function seedMultiMount(volume: MemoryVolume): void {
			volume.fromJSON({
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

			const { fileSystem, volume } = createMemoryFileSystem();
			seedMultiMount(volume);
			const mocked = await mockInstrumentRootAsync();

			const [result] = prepareWorkspaceCoverage({
				fileSystem,
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
			expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual([
				"src",
			]);

			const manifest = manifestSchema.assert(
				JSON.parse(volume.readFileSync(result!.manifestPath, "utf-8").toString()),
			);

			expect(manifest.luauRoots).toHaveLength(1);
		});

		it("should preserve existing behavior (walk every $path) when descriptor.luauRoots is undefined", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			seedMultiMount(volume);
			const mocked = await mockInstrumentRootAsync();

			const [result] = prepareWorkspaceCoverage({
				fileSystem,
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
			expect(
				result!.coverageRoots.map((entry): string => entry.luauRoot).sort(),
			).toStrictEqual(["src", "vendored-packages"]);
		});

		it("should drop off-tree luauRoot entries with a stderr warning", async () => {
			expect.assertions(3);

			const { fileSystem, volume } = createMemoryFileSystem();
			seedMultiMount(volume);
			const mocked = await mockInstrumentRootAsync();
			const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

			const [result] = prepareWorkspaceCoverage({
				fileSystem,
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
			expect(result!.coverageRoots).toStrictEqual([]);

			const warnings = writeSpy.mock.calls.map(([chunk]) => String(chunk));

			expect(warnings.some(mentionsMissingFooRoot)).toBeTrue();
		});

		it("should fall through to the rojo walk when descriptor.luauRoots is an empty array", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();
			seedMultiMount(volume);
			const mocked = await mockInstrumentRootAsync();

			prepareWorkspaceCoverage({
				fileSystem,
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

			const { fileSystem, volume } = createMemoryFileSystem();
			// Workspace-mode reads ignore patterns from each
			// package's own config (or DEFAULT_CONFIG when omitted) — not
			// from a workspace-root jest.config. The descriptor has no
			// per-pkg override here, so the workspace-root custom value
			// below must be ignored and both rojo mounts instrumented.
			seedMultiMount(volume);
			const mocked = await mockInstrumentRootAsync();

			const [result] = prepareWorkspaceCoverage({
				fileSystem,
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
			expect(
				result!.coverageRoots.map((entry): string => entry.luauRoot).sort(),
			).toStrictEqual(["src", "vendored-packages"]);
		});

		it("should honor per-pkg coveragePathIgnorePatterns over the DEFAULT_CONFIG fallback", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			seedMultiMount(volume);
			const mocked = await mockInstrumentRootAsync();

			const [result] = prepareWorkspaceCoverage({
				fileSystem,
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
			expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual([
				"src",
			]);
		});

		it("should honor per-pkg coverageCopyIgnorePatterns over the DEFAULT_CONFIG fallback", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			seedMultiMount(volume);
			volume.writeFileSync(path.join(FOO_DIR, "src/notes.md"), "keep me");
			volume.writeFileSync(path.join(FOO_DIR, "src/build.tsbuildinfo"), "{}");
			await mockInstrumentRootAsync();

			const [result] = prepareWorkspaceCoverage({
				fileSystem,
				packages: [
					{
						name: "@halcyon/foo",
						coverageCopyIgnorePatterns: ["**/*.tsbuildinfo"],
						luauRoots: ["src"],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			const mirrored = Object.keys(result!.manifest.nonInstrumentedFiles);

			expect(mirrored.some((entry) => entry.endsWith("src/notes.md"))).toBeTrue();
			expect(mirrored.some((entry) => entry.endsWith(".tsbuildinfo"))).toBeFalse();
		});

		it("should rebuild a package cold when its copy-ignore list changed", async () => {
			expect.assertions(3);

			const { fileSystem, volume } = createMemoryFileSystem();
			// Workspace mode writes its own manifest and runs its own
			// incremental gate, so the single/multi warm-cache test cannot
			// speak for it.
			const packageShadow = path
				.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage")
				.replaceAll("\\", "/");
			const fileKey = `${path.join(FOO_DIR, "src").replaceAll("\\", "/")}/init.luau`;
			const mirroredKey = `${path.join(FOO_DIR, "src").replaceAll("\\", "/")}/build.tsbuildinfo`;
			const previousManifest: CoverageManifest = {
				buildId: "prev-build-id",
				// Written under the defaults; the run below adds a pattern.
				copyIgnoreHash: DEFAULT_COPY_IGNORE_HASH,
				files: {
					[fileKey]: {
						key: fileKey,
						coverageMapPath: `${fileKey}.cov-map.json`,
						instrumentedLuauPath: `${packageShadow}/src/init.luau`,
						originalLuauPath: fileKey,
						sourceHash: sha256("local x = 1"),
						sourceMapPath: `${fileKey}.map`,
						statementCount: 1,
					},
				},
				generatedAt: isoNow(),
				instrumenterVersion: INSTRUMENTER_VERSION,
				luauRoots: [`${packageShadow}/src`],
				nonInstrumentedFiles: {
					[mirroredKey]: {
						shadowPath: `${packageShadow}/src/build.tsbuildinfo`,
						sourceHash: sha256("{}"),
						sourcePath: mirroredKey,
					},
				},
				shadowDir: packageShadow,
				version: MANIFEST_VERSION,
			};

			seedMultiMount(volume);
			volume.writeFileSync(mirroredKey, "{}");
			volume.mkdirSync(`${packageShadow}/src`, { recursive: true });
			volume.writeFileSync(
				`${packageShadow}/coverage-manifest.json`,
				JSON.stringify(previousManifest),
			);
			volume.writeFileSync(`${packageShadow}/src/build.tsbuildinfo`, "{}");
			// A sidecar whose module still exists in source: the warm reconcile
			// keeps it, so only a cold rmSync can take it. Anything the
			// reconcile would drop anyway cannot tell the two paths apart.
			volume.writeFileSync(`${packageShadow}/src/init.cov-map.json`, "{}");
			const mocked = await mockInstrumentRootAsync();

			const [result] = prepareWorkspaceCoverage({
				fileSystem,
				packages: [
					{
						name: "@halcyon/foo",
						coverageCopyIgnorePatterns: ["**/*.tsbuildinfo"],
						luauRoots: ["src"],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(volume.existsSync(`${packageShadow}/src/init.cov-map.json`)).toBeFalse();
			expect(result!.manifest.nonInstrumentedFiles).not.toHaveProperty(mirroredKey);
			expect(mocked).toHaveBeenCalledOnce();
		});

		it("should instrument every mount when the descriptor opts out of every pattern via an empty array", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			// Per-pkg `coveragePathIgnorePatterns: []` means "no ignore
			// patterns" — even DEFAULT_CONFIG's defaults don't apply, so a
			// directory named like a spec/test mount would still be
			// instrumented. The empty-patterns branch of `createIgnoreMatcher`
			// has no other caller after the workspace-root drop.
			seedMultiMount(volume);
			const mocked = await mockInstrumentRootAsync();

			const [result] = prepareWorkspaceCoverage({
				fileSystem,
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
			expect(
				result!.coverageRoots.map((entry): string => entry.luauRoot).sort(),
			).toStrictEqual(["src", "vendored-packages"]);
		});

		it("should take a luauRoot nested below the $path mount that covers it", async () => {
			expect.assertions(4);

			const { fileSystem, volume } = createMemoryFileSystem();
			// rojo mounts `src` whole; the package opts into a narrower
			// `luauRoot` underneath it. The mount above is demoted onto its
			// spine copy, so the place loads the instrumented subtree.
			volume.fromJSON({
				[FOO_PROJECT]: JSON.stringify({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { Src: { $path: "src" } },
					},
				}),
				[path.join(FOO_DIR, "src/client/init.luau")]: "local x = 1",
			});
			const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			const mocked = await mockInstrumentRootAsync();

			const [result] = prepareWorkspaceCoverage({
				fileSystem,
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
			expect(result!.coverageRoots.map((root): string => root.luauRoot)).toStrictEqual([
				"src/client",
			]);
			expect(result!.coverageSpine.map((entry): string => entry.luauRoot)).toStrictEqual([
				"src",
			]);
			expect(stderr).not.toHaveBeenCalled();
		});

		it("should demote the deepest containing mount when several sit above the root", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();
			// `src` and `src/client` both sit above `src/client/ui`, and
			// `src/client` is the one the place reads it through. Declared
			// shallow-first so the deeper mount has to displace an incumbent.
			volume.fromJSON({
				[FOO_PROJECT]: JSON.stringify({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							ASrc: { $path: "src" },
							BClient: { $path: "src/client" },
						},
					},
				}),
				[path.join(FOO_DIR, "src/client/ui/init.luau")]: "local x = 1",
			});
			await mockInstrumentRootAsync();

			const [result] = prepareWorkspaceCoverage({
				fileSystem,
				packages: [
					{
						name: "@halcyon/foo",
						luauRoots: ["src/client/ui"],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(result!.coverageSpine.map((entry): string => entry.luauRoot)).toStrictEqual([
				"src/client",
			]);
		});

		it("should demote the deepest containing mount whichever order they are declared", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();
			// The test above, deep-first: the shallower mount must not displace
			// the incumbent it contains.
			volume.fromJSON({
				[FOO_PROJECT]: JSON.stringify({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							AClient: { $path: "src/client" },
							BSrc: { $path: "src" },
						},
					},
				}),
				[path.join(FOO_DIR, "src/client/ui/init.luau")]: "local x = 1",
			});
			await mockInstrumentRootAsync();

			const [result] = prepareWorkspaceCoverage({
				fileSystem,
				packages: [
					{
						name: "@halcyon/foo",
						luauRoots: ["src/client/ui"],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(result!.coverageSpine.map((entry): string => entry.luauRoot)).toStrictEqual([
				"src/client",
			]);
		});

		it("should reject a luauRoot that escapes the package through a traversal", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			// Spelled with no leading `..`, so only resolving it reveals that it
			// lands outside the package — on a directory the rojo tree really
			// does mount, so reachability alone would wave it through.
			volume.fromJSON({
				[FOO_PROJECT]: JSON.stringify({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { Bar: { $path: "../bar" } },
					},
				}),
				[path.join(BAR_DIR, "init.luau")]: "local x = 1",
			});
			const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			const mocked = await mockInstrumentRootAsync();

			prepareWorkspaceCoverage({
				fileSystem,
				packages: [
					{
						name: "@halcyon/foo",
						luauRoots: ["src/../../bar"],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(mocked).not.toHaveBeenCalled();
			expect(stderr).toHaveBeenCalledExactlyOnceWith(
				'Warning: luauRoot "src/../../bar" in @halcyon/foo is not a directory inside the package, so it reports no coverage.\n',
			);
		});

		it("should reject a traversal that resolves back to the package root", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			volume.fromJSON({
				[FOO_PROJECT]: JSON.stringify({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { Root: { $path: "." } },
					},
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "local x = 1",
			});
			const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			const mocked = await mockInstrumentRootAsync();

			prepareWorkspaceCoverage({
				fileSystem,
				packages: [
					{
						name: "@halcyon/foo",
						luauRoots: ["src/.."],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(mocked).not.toHaveBeenCalled();
			expect(stderr).toHaveBeenCalledExactlyOnceWith(
				'Warning: luauRoot "src/.." in @halcyon/foo is not a directory inside the package, so it reports no coverage.\n',
			);
		});

		it("should accept a directory whose name merely starts with two dots", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			// `..cache` is a directory inside the package, not a step out of it.
			volume.fromJSON({
				[FOO_PROJECT]: JSON.stringify({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { Cache: { $path: "..cache" } },
					},
				}),
				[path.join(FOO_DIR, "..cache/init.luau")]: "local x = 1",
			});
			const mocked = await mockInstrumentRootAsync();

			const [result] = prepareWorkspaceCoverage({
				fileSystem,
				packages: [
					{
						name: "@halcyon/foo",
						luauRoots: ["..cache"],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(mocked).toHaveBeenCalledOnce();
			expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual([
				"..cache",
			]);
		});

		it("should reject an empty luauRoot, which names the package itself", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			volume.fromJSON({
				[FOO_PROJECT]: JSON.stringify({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { Src: { $path: "src" } },
					},
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "local x = 1",
			});
			const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			const mocked = await mockInstrumentRootAsync();

			prepareWorkspaceCoverage({
				fileSystem,
				packages: [
					{
						name: "@halcyon/foo",
						luauRoots: [""],
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			expect(mocked).not.toHaveBeenCalled();
			expect(stderr).toHaveBeenCalledExactlyOnceWith(
				'Warning: luauRoot "" in @halcyon/foo is not a directory inside the package, so it reports no coverage.\n',
			);
		});

		it("should accept a luauRoot nested below one mount when a finer mount lands on it", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			// rojo mounts both `src` and `src/client`. The finer mount is the
			// one that redirects, so the nested root is reachable after all.
			volume.fromJSON({
				[FOO_PROJECT]: JSON.stringify({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							Client: { $path: "src/client" },
							Src: { $path: "src" },
						},
					},
				}),
				[path.join(FOO_DIR, "src/client/init.luau")]: "local x = 1",
			});
			const mocked = await mockInstrumentRootAsync();

			const [result] = prepareWorkspaceCoverage({
				fileSystem,
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
			expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual([
				"src/client",
			]);
		});

		it("should accept a luauRoot that contains a finer-grained $path mount", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			// rojo mounts `src/client` only; the package opts into the
			// broader `src` as its luauRoot. Exercises the
			// `mount.startsWith(candidate/)` branch of `isOnRojoTree`.
			volume.fromJSON({
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
			const mocked = await mockInstrumentRootAsync();

			const [result] = prepareWorkspaceCoverage({
				fileSystem,
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
			expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual([
				"src",
			]);
		});

		it("should deduplicate repeated luauRoots entries", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			seedMultiMount(volume);
			const mocked = await mockInstrumentRootAsync();

			const [result] = prepareWorkspaceCoverage({
				fileSystem,
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
			expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual([
				"src",
			]);
		});

		it("should skip a luauRoot that is on the rojo tree but has no instrumentable files", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			// rojo mounts `src` (with content) and `empty` (no luau files).
			// `empty` is on-tree per `isOnRojoTree` but `containsLuauFiles`
			// returns false; `isInstrumentableRoot` drops it.
			volume.fromJSON({
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
			const mocked = await mockInstrumentRootAsync();

			const [result] = prepareWorkspaceCoverage({
				fileSystem,
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
			expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual([
				"src",
			]);
		});

		it("should cold-rebuild the shadow when luauRoots shrinks between runs", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			const packageShadow = path
				.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage")
				.replaceAll("\\", "/");
			const staleVendoredShadow = path.join(packageShadow, "vendored-packages/dep/init.luau");
			const sourceFileKey = `${path.join(FOO_DIR, "src").replaceAll("\\", "/")}/init.luau`;
			const vendoredShadowDirectory = path.join(packageShadow, "vendored-packages");
			const previousManifest: CoverageManifest = {
				buildId: "prev-build-id",
				copyIgnoreHash: DEFAULT_COPY_IGNORE_HASH,
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
				generatedAt: isoNow(),
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

			volume.fromJSON({
				[FOO_PROJECT]: JSON.stringify({ name: "foo-test", tree: multiMountTree }),
				[path.join(FOO_DIR, "src/init.luau")]: "local x = 1",
				[path.join(FOO_DIR, "vendored-packages/dep/init.luau")]: "local y = 2",
				[path.join(packageShadow, "coverage-manifest.json")]:
					JSON.stringify(previousManifest),
				// Stale shadow file from the prior mount that the new run drops.
				[staleVendoredShadow]: "return {}",
			});
			await mockInstrumentRootAsync();

			prepareWorkspaceCoverage({
				fileSystem,
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

			expect(volume.existsSync(staleVendoredShadow)).toBeFalse();
			expect(volume.existsSync(vendoredShadowDirectory)).toBeFalse();
		});

		it("should cold-rebuild when luauRoots size matches but membership changes", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();
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
				copyIgnoreHash: DEFAULT_COPY_IGNORE_HASH,
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
				generatedAt: isoNow(),
				instrumenterVersion: INSTRUMENTER_VERSION,
				luauRoots: [path.join(packageShadow, "vendored-packages").replaceAll("\\", "/")],
				nonInstrumentedFiles: {},
				shadowDir: packageShadow,
				version: MANIFEST_VERSION,
			};

			volume.fromJSON({
				[FOO_PROJECT]: JSON.stringify({ name: "foo-test", tree: multiMountTree }),
				[path.join(FOO_DIR, "src/init.luau")]: "local x = 1",
				[path.join(FOO_DIR, "vendored-packages/dep/init.luau")]: "local y = 2",
				[path.join(packageShadow, "coverage-manifest.json")]:
					JSON.stringify(previousManifest),
				[staleVendoredShadow]: "return {}",
			});
			await mockInstrumentRootAsync();

			prepareWorkspaceCoverage({
				fileSystem,
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

			expect(volume.existsSync(staleVendoredShadow)).toBeFalse();
		});

		it("should preserve the cache when luauRoots is unchanged between runs", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();
			// Cache hit with matching luauRoots set: prior shadow survives and
			// `useIncremental` stays `true`. Exercises the
			// `setsEqual === true` branch.
			const packageShadow = path
				.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage")
				.replaceAll("\\", "/");
			const fileKey = `${path.join(FOO_DIR, "out").replaceAll("\\", "/")}/init.luau`;
			const previousManifest: CoverageManifest = {
				buildId: "prev-build-id",
				copyIgnoreHash: DEFAULT_COPY_IGNORE_HASH,
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
				generatedAt: isoNow(),
				instrumenterVersion: INSTRUMENTER_VERSION,
				luauRoots: [path.join(packageShadow, "out").replaceAll("\\", "/")],
				nonInstrumentedFiles: {},
				shadowDir: packageShadow,
				version: MANIFEST_VERSION,
			};

			seedPackage(volume, FOO_DIR);
			volume.fromJSON({
				[path.join(packageShadow, "coverage-manifest.json")]:
					JSON.stringify(previousManifest),
				// A sidecar marker: reconciliation keeps it (its base
				// `init.luau` source exists), but a cold rmSync would wipe it and
				// no mirror pass can restore it (sidecars aren't in source). So
				// its survival proves the shadow was preserved, not rebuilt.
				[path.join(packageShadow, "out/init.cov-map.json")]: "{}",
			});
			await mockInstrumentRootAsync();

			prepareWorkspaceCoverage({
				fileSystem,
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				workspaceRoot: WORKSPACE_ROOT,
			});

			// Cache preserved → rmSync did not fire, the sidecar is still there.
			expect(volume.existsSync(path.join(packageShadow, "out/init.cov-map.json"))).toBeTrue();
		});

		it("should skip rojo $path entries that escape the package directory", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			// `..` path escapes the package — the relative path starts with
			// "..", which `buildRojoMountSet` drops. Combined with a per-pkg
			// `luauRoots` that lists the absolute-equivalent root, this
			// confirms the off-tree filter and the warning fire.
			volume.fromJSON({
				[FOO_PROJECT]: JSON.stringify({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { External: { $path: "../sibling" } },
					},
				}),
				[path.join(WORKSPACE_ROOT, "sibling/init.luau")]: "local x = 1",
			});
			await mockInstrumentRootAsync();
			const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

			const [result] = prepareWorkspaceCoverage({
				fileSystem,
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

			expect(result!.coverageRoots).toStrictEqual([]);
			expect(writeSpy).toHaveBeenCalledWith(
				expect.stringContaining('luauRoot "sibling" in @halcyon/foo'),
			);
		});
	});
});

describe(emitWorkspaceBuildManifests, () => {
	it("should write a build-manifest.json next to each package's coverage-manifest.json", async () => {
		expect.assertions(4);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, FOO_DIR);
		await mockInstrumentRootAsync();

		const entries = prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		emitWorkspaceBuildManifests(entries, SHARED_PLACE, fileSystem);

		const buildManifestPath = path.join(
			WORKSPACE_ROOT,
			".jest-roblox/workspace/@halcyon-foo/coverage/build-manifest.json",
		);

		expect(volume.existsSync(buildManifestPath)).toBeTrue();

		const manifest = buildManifestSchema.assert(
			JSON.parse(volume.readFileSync(buildManifestPath, "utf-8").toString()),
		);

		expect(manifest.buildId).toBe(entries[0]!.manifest.buildId);
		expect(manifest.coveragePlace).toStrictEqual(SHARED_PLACE);
		expect(manifest.cleanPlace).toBeUndefined();
	});

	it("should emit an independent build manifest per package over the one shared place", async () => {
		expect.assertions(5);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, FOO_DIR);
		seedPackage(volume, BAR_DIR);
		await mockInstrumentRootAsync();

		const entries = prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
				{ name: "@halcyon/bar", packageDirectory: BAR_DIR, rojoProjectPath: BAR_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		emitWorkspaceBuildManifests(entries, SHARED_PLACE, fileSystem);

		const foo = readPackageBuildManifest(volume, "@halcyon-foo");
		const bar = readPackageBuildManifest(volume, "@halcyon-bar");
		const fooEntry = entries.find((entry) => entry.pkg === "@halcyon/foo");
		const barEntry = entries.find((entry) => entry.pkg === "@halcyon/bar");

		expect(foo.buildId).toBe(fooEntry!.manifest.buildId);
		expect(bar.buildId).toBe(barEntry!.manifest.buildId);
		expect(foo.buildId).not.toBe(bar.buildId);
		expect(foo.coveragePlace).toStrictEqual(SHARED_PLACE);
		expect(bar.coveragePlace).toStrictEqual(SHARED_PLACE);
	});

	it("should project files to sourceHash records and leave projects empty", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, FOO_DIR);
		await mockInstrumentRootAsync();

		const entries = prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			workspaceRoot: WORKSPACE_ROOT,
		});

		emitWorkspaceBuildManifests(entries, SHARED_PLACE, fileSystem);

		const manifest = readPackageBuildManifest(volume, "@halcyon-foo");
		const expectedKey = `${path.join(FOO_DIR, "out").replaceAll("\\", "/")}/init.luau`;

		expect(manifest.files).toStrictEqual({ [expectedKey]: { sourceHash: "deadbeef" } });
		expect(manifest.projects).toStrictEqual([]);
	});
});

function readPackageBuildManifest(volume: MemoryVolume, safeName: string): BuildManifest {
	const buildManifestPath = path.join(
		WORKSPACE_ROOT,
		`.jest-roblox/workspace/${safeName}/coverage/build-manifest.json`,
	);
	return buildManifestSchema.assert(
		JSON.parse(volume.readFileSync(buildManifestPath, "utf-8").toString()),
	);
}

describe("narrowing a workspace package to its coverage universe", () => {
	/** A package whose probes all sit in one subtree below its rojo mount. */
	function seedNarrowablePackage(volume: MemoryVolume): void {
		volume.fromJSON({
			[FOO_PROJECT]: JSON.stringify({
				name: "foo-test",
				tree: { $className: "DataModel", ReplicatedStorage: { Pkg: { $path: "out" } } },
			}),
			[path.join(FOO_DIR, "out/client/button.luau")]: "local x = 1",
			[path.join(FOO_DIR, "out/loose.luau")]: "local x = 2",
			[path.join(FOO_DIR, "out/modules/ecs/world.luau")]: "local x = 3",
			[path.join(FOO_DIR, "out/modules/net.luau")]: "local x = 4",
		});
	}

	function prepareNarrowed(fileSystem: FileSystem): ReturnType<typeof prepareWorkspaceCoverage> {
		return prepareWorkspaceCoverage({
			fileSystem,
			packages: [
				{
					name: "@halcyon/foo",
					collectCoverageFrom: ["**/ecs/**"],
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
			],
			workspaceRoot: WORKSPACE_ROOT,
		});
	}

	it("should instrument the narrowed root rather than the whole mount", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedNarrowablePackage(volume);
		await mockInstrumentRootAsync();

		const [result] = prepareNarrowed(fileSystem);

		expect(result!.coverageRoots.map((root): string => root.luauRoot)).toStrictEqual([
			"out/modules/ecs",
		]);
	});

	it("should name the demoted mount and carry its loose files onto the spine", async () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedNarrowablePackage(volume);
		await mockInstrumentRootAsync();

		const [result] = prepareNarrowed(fileSystem);

		expect(result!.coverageSpine.map((entry): string => entry.luauRoot)).toStrictEqual([
			"out",
			"out/modules",
		]);
		expect(
			volume.existsSync(
				path.join(
					WORKSPACE_ROOT,
					".jest-roblox/workspace/@halcyon-foo/coverage/.spine/out/.self/loose.luau",
				),
			),
		).toBeTrue();
		// Recorded, not just copied: the hash is what lets a warm run leave the
		// copy alone rather than write it again.
		expect(Object.keys(result!.manifest.nonInstrumentedFiles)).toContain(
			normalizeWindowsPath(path.join(FOO_DIR, "out/loose.luau")),
		);
	});
});
