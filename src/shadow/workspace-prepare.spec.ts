import { fromAny } from "@total-typescript/shoehorn";

import { type } from "arktype";
import * as crypto from "node:crypto";
import * as path from "node:path";
import process from "node:process";
import type { Except, SetOptional as PartialBy } from "type-fest";
import type { MockedFunction } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { copyIgnoreHash } from "#test/mocks/coverage-hash.ts";
import { INSTRUMENTER_VERSION, MANIFEST_VERSION } from "#test/mocks/coverage-versions.ts";
import type { MemoryVolume } from "#test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixPath, posixRoot } from "#test/mocks/posix-path.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { CoverageSettings } from "../config/coverage-settings.ts";
import type { BuildManifest, BuildManifestArtifact } from "../coverage-data/build-manifest.ts";
import type { CoverageManifest, InstrumentedFileRecord } from "../coverage-data/manifest.ts";
import type { Instrumenter } from "../instrument/instrumenter.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { WorkspaceCoveragePackage } from "./workspace-prepare-types.ts";
import type { PrepareWorkspaceCoverageOptions } from "./workspace-prepare.ts";
import { emitWorkspaceBuildManifests, prepareWorkspaceCoverage } from "./workspace-prepare.ts";

function sha256(content: string): string {
	return crypto.createHash("sha256").update(content).digest("hex");
}

function isoNow(): string {
	const now = new Date();
	return now.toISOString();
}

const DEFAULT_COPY_IGNORE_HASH = copyIgnoreHash(createResolvedConfig().coverageCopyIgnorePatterns);

const WORKSPACE_ROOT = path.resolve("/repo");
const FOO_DIR = path.join(WORKSPACE_ROOT, "packages/foo");
const BAR_DIR = path.join(WORKSPACE_ROOT, "packages/bar");
const CACHE_DIRECTORY = path.join(WORKSPACE_ROOT, ".jest-roblox/workspace");
const FOO_PROJECT = path.join(FOO_DIR, "test.project.json");
const BAR_PROJECT = path.join(BAR_DIR, "test.project.json");
const SHARED_PLACE: BuildManifestArtifact = {
	hash: "place-hash",
	path: "synthesized.rbxl",
};

interface SeedOptions {
	luauRoots?: Array<string>;
	packageDirectory: string;
	rojoTree?: object;
}

function seedPackage(
	volume: MemoryVolume,
	{
		luauRoots = ["out"],
		packageDirectory,
		rojoTree = {
			$className: "DataModel",
			ReplicatedStorage: { Pkg: { $path: "out" } },
		},
	}: SeedOptions,
): void {
	volume.fromJSON({
		[path.join(packageDirectory, "test.project.json")]: JSON.stringify({
			name: "pkg-test",
			tree: rojoTree,
		}),
	});
	for (const luauRoot of luauRoots) {
		volume.mkdirSync(path.join(packageDirectory, luauRoot), {
			recursive: true,
		});
		volume.writeFileSync(path.join(packageDirectory, luauRoot, "init.luau"), "local x = 1");
	}
}

function createInstrumenter(
	implementation?: (options: {
		luauRoot: string;
		shadowDir: string;
	}) => Record<string, InstrumentedFileRecord>,
): MockedFunction<Instrumenter> {
	const instrumenter = vi.fn<Instrumenter>();
	instrumenter.mockImplementation(
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
	return instrumenter;
}

const FOO_SHADOW = posixPath(
	path.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage"),
);
const FOO_MANIFEST_PATH = path.join(FOO_SHADOW, "coverage-manifest.json");

type LoosePackage = Except<
	PartialBy<WorkspaceCoveragePackage, keyof CoverageSettings>,
	"rootDir"
> & {
	rootDir?: string | undefined;
};

type FooDescriptorFields = Except<LoosePackage, "name" | "packageDirectory" | "rojoProjectPath">;

/**
 * Fill each package's coverage settings with the loaded defaults.
 * @param options - Prepare options whose packages may omit settings.
 * @returns What the prepare pass returned.
 */
function prepare(
	options: Except<PrepareWorkspaceCoverageOptions, "packages"> & {
		packages: Array<LoosePackage>;
	},
): ReturnType<typeof prepareWorkspaceCoverage> {
	const defaults = createResolvedConfig();
	return prepareWorkspaceCoverage({
		...options,
		packages: options.packages.map((loose) => {
			return {
				collectCoverageFrom: [],
				coverageCache: defaults.coverageCache,
				coverageCopyIgnorePatterns: defaults.coverageCopyIgnorePatterns,
				coveragePathIgnorePatterns: defaults.coveragePathIgnorePatterns,
				...loose,
				rootDir: loose.rootDir ?? loose.packageDirectory,
			};
		}),
	});
}

function prepareFoo({
	descriptor,
	fileSystem,
	instrumenter,
}: {
	descriptor?: FooDescriptorFields;
	fileSystem: FileSystem;
	instrumenter?: Instrumenter | undefined;
}): ReturnType<typeof prepareWorkspaceCoverage> {
	return prepare({
		cacheDirectory: CACHE_DIRECTORY,
		fileSystem,
		instrumenter,
		packages: [
			{
				name: "@halcyon/foo",
				...descriptor,
				packageDirectory: FOO_DIR,
				rojoProjectPath: FOO_PROJECT,
			},
		],
	});
}

function fooProject(tree: object): Record<string, string> {
	return { [FOO_PROJECT]: JSON.stringify({ name: "foo-test", tree }) };
}

const OUT_SOURCE = "local x = 1";

interface WrittenManifest {
	files: Record<string, unknown>;
	luauRoots: Array<string>;
	nonInstrumentedFiles: Record<string, unknown>;
}

function cachedOutManifest(overrides: Partial<CoverageManifest>): CoverageManifest {
	const fileKey = `${posixPath(path.join(FOO_DIR, "out"))}/init.luau`;
	return {
		buildId: "prev-build-id",
		copyIgnoreHash: DEFAULT_COPY_IGNORE_HASH,
		files: {
			[fileKey]: {
				key: fileKey,
				coverageMapPath: `${FOO_SHADOW}/out/init.cov-map.json`,
				instrumentedLuauPath: `${FOO_SHADOW}/out/init.luau`,
				originalLuauPath: fileKey,
				sourceHash: sha256(OUT_SOURCE),
				sourceMapPath: `${FOO_SHADOW}/out/init.luau.map`,
				statementCount: 1,
			},
		},
		generatedAt: "2025-01-01T00:00:00.000Z",
		instrumenterVersion: INSTRUMENTER_VERSION,
		luauRoots: ["out"],
		nonInstrumentedFiles: {},
		shadowDir: FOO_SHADOW,
		version: MANIFEST_VERSION,
		...overrides,
	};
}

function seedCachedOut(
	volume: MemoryVolume,
	{ manifest, shadowOutputs }: { manifest: CoverageManifest; shadowOutputs: boolean },
): void {
	seedPackage(volume, { packageDirectory: FOO_DIR });
	volume.fromJSON({ [FOO_MANIFEST_PATH]: JSON.stringify(manifest) });
	if (shadowOutputs) {
		volume.fromJSON({
			[`${FOO_SHADOW}/out/init.cov-map.json`]: "{}",
			[`${FOO_SHADOW}/out/init.luau`]: "instrumented",
		});
	}
}

function priorRootsManifest({
	content,
	fileKey,
	luauRoots,
}: {
	content: string;
	fileKey: string;
	luauRoots: Array<string>;
}): CoverageManifest {
	return {
		buildId: "prev-build-id",
		copyIgnoreHash: DEFAULT_COPY_IGNORE_HASH,
		files: {
			[fileKey]: {
				key: fileKey,
				coverageMapPath: `${fileKey}.cov-map.json`,
				instrumentedLuauPath: fileKey,
				originalLuauPath: fileKey,
				sourceHash: sha256(content),
				sourceMapPath: `${fileKey}.map`,
				statementCount: 1,
			},
		},
		generatedAt: isoNow(),
		instrumenterVersion: INSTRUMENTER_VERSION,
		luauRoots,
		nonInstrumentedFiles: {},
		shadowDir: FOO_SHADOW,
		version: MANIFEST_VERSION,
	};
}

function seedMixedOutTest(volume: MemoryVolume): void {
	volume.fromJSON({
		...fooProject({
			$className: "DataModel",
			ReplicatedStorage: { Tests: { $path: "out-test" } },
		}),
		[path.join(FOO_DIR, "out-test/src/foo.spec.luau")]: "return {}",
		[path.join(FOO_DIR, "out-test/test/fixtures.luau")]: "local x = 1",
	});
}

function manifestFileKeys(manifest: CoverageManifest): Array<string> {
	return Object.keys(manifest.files)
		.map((file) => posixPath(path.relative(FOO_DIR, file)))
		.sort();
}

function captureStderr(): () => string {
	let text = "";
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		text += String(chunk);
		return true;
	});
	return () => text;
}

const writtenManifestSchema = type({
	"+": "ignore",
	"files": "Record<string, unknown>",
	"luauRoots": "string[]",
	"nonInstrumentedFiles": "Record<string, unknown>",
}).as<WrittenManifest>();

/**
 * The fields of a published coverage manifest that these specs read.
 *
 * @param volume - Where the run wrote it.
 * @param manifestPath - Where the manifest sits on the volume.
 * @returns The manifest, checked only for the fields `WrittenManifest` names.
 * @throws When the file is not JSON or lacks one of those fields.
 */
function readManifest(volume: MemoryVolume, manifestPath: string): WrittenManifest {
	return writtenManifestSchema.assert(
		JSON.parse(volume.readFileSync(manifestPath, "utf-8").toString()),
	);
}

describe(prepareWorkspaceCoverage, () => {
	it.for([
		{ collectCoverageFrom: undefined, expected: ["init.luau"] },
		{
			collectCoverageFrom: ["**/*"],
			expected: ["init.luau", "start.client.luau", "start.server.lua"],
		},
	])(
		"should select script instrumentation in workspace mode with include $collectCoverageFrom",
		({ collectCoverageFrom, expected }) => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();
			seedPackage(volume, { packageDirectory: FOO_DIR });
			const directory = path.join(FOO_DIR, "out");
			volume.writeFileSync(path.join(directory, "start.client.luau"), "local x = 2");
			volume.writeFileSync(path.join(directory, "start.server.lua"), "local x = 3");
			const result = prepareFoo({
				descriptor: { collectCoverageFrom, coveragePathIgnorePatterns: [] },
				fileSystem,
			});
			const files = Object.keys(result[0]!.manifest.files);

			expect(files.map((file) => path.basename(file)).sort()).toStrictEqual(expected);
		},
	);

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
			seedPackage(volume, { packageDirectory: FOO_DIR });
			volume.mkdirSync(path.join(FOO_DIR, "out/ui"), { recursive: true });
			volume.writeFileSync(path.join(FOO_DIR, "out/ui/button.luau"), "local y = 2");

			const result = prepare({
				cacheDirectory: CACHE_DIRECTORY,
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
			});

			expect(Object.keys(result[0]!.manifest.files)).toStrictEqual([
				posixPath(path.join(FOO_DIR, "out/init.luau")),
			]);
			expect(result[0]!.manifest.coverageUniverseHash).toMatch(/^[a-f0-9]{64}$/);
		},
	);

	it("should leave a root the universe never touches out of the coverage roots", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, {
			luauRoots: ["out", "vendor"],
			packageDirectory: FOO_DIR,
			rojoTree: {
				$className: "DataModel",
				ReplicatedStorage: {
					Pkg: { $path: "out" },
					Vendor: { $path: "vendor" },
				},
			},
		});
		const instrumenter = createInstrumenter();

		const [result] = prepareFoo({
			descriptor: { collectCoverageFrom: ["out/init.luau"] },
			fileSystem,
			instrumenter,
		});

		// Only `out` earns a redirect; `vendor` keeps its original mount, which
		// serves exactly the bytes a shadow of it would have.
		expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual(["out"]);
	});

	it("should instrument the whole package with explicitly unrestricted coverage", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, { packageDirectory: FOO_DIR });

		const result = prepareFoo({ fileSystem });

		expect(Object.keys(result[0]!.manifest.files)).toStrictEqual([
			posixPath(path.join(FOO_DIR, "out/init.luau")),
		]);
		expect(result[0]!.manifest.coverageUniverseHash).toBeUndefined();
	});

	it("should return per-package coverage roots whose luauRoot is package-relative and shadowDir is absolute", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, { packageDirectory: FOO_DIR });
		const instrumenter = createInstrumenter();

		const result = prepareFoo({ fileSystem, instrumenter });

		expect(result).toHaveLength(1);
		expect(result[0]!.coverageRoots).toStrictEqual([
			{
				luauRoot: posixRoot("out"),
				shadowDir: path
					.join(WORKSPACE_ROOT, ".jest-roblox/workspace/@halcyon-foo/coverage/out")
					.replaceAll("\\", "/"),
			},
		]);
	});

	it("should write a per-package manifest at workspace-root-scoped path", async () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, { packageDirectory: FOO_DIR });
		const instrumenter = createInstrumenter();

		const result = prepareFoo({ fileSystem, instrumenter });

		const expectedPath = FOO_MANIFEST_PATH;

		expect(result[0]!.manifestPath).toBe(expectedPath.replaceAll("\\", "/"));
		expect(volume.existsSync(expectedPath)).toBeTrue();
		expect(volume.readFileSync(expectedPath, "utf8")).toContain('\n\t"buildId":');
	});

	it("should publish instrumented files from every discovered luau root", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, {
			luauRoots: ["out/client", "out/server"],
			packageDirectory: FOO_DIR,
			rojoTree: {
				$className: "DataModel",
				ReplicatedStorage: { Client: { $path: "out/client" } },
				ServerScriptService: { Server: { $path: "out/server" } },
			},
		});

		const [result] = prepareFoo({ fileSystem });

		expect(Object.keys(result!.manifest.files)).toStrictEqual([
			posixPath(path.join(FOO_DIR, "out/client/init.luau")),
			posixPath(path.join(FOO_DIR, "out/server/init.luau")),
		]);
	});

	it("should isolate shadow dirs and manifests between packages", async () => {
		expect.assertions(4);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, { packageDirectory: FOO_DIR });
		seedPackage(volume, { packageDirectory: BAR_DIR });
		const instrumenter = createInstrumenter();

		const result = prepare({
			cacheDirectory: CACHE_DIRECTORY,
			fileSystem,
			instrumenter,
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
				{
					name: "@halcyon/bar",
					packageDirectory: BAR_DIR,
					rojoProjectPath: BAR_PROJECT,
				},
			],
		});

		const fooManifest = FOO_MANIFEST_PATH;
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
		seedPackage(volume, { packageDirectory: FOO_DIR });
		const instrumenter = createInstrumenter();

		const [result] = prepareFoo({ fileSystem, instrumenter });

		const manifest = readManifest(volume, result!.manifestPath);
		const expectedKey = `${path.join(FOO_DIR, "out").replaceAll("\\", "/")}/init.luau`;

		expect(Object.keys(manifest.files)).toContain(expectedKey);
	});

	// Codex review follow-up: a cold run only ever adds to the package shadow:
	// the instrumenter and the mirror sync both merge, and the reconcile that
	// deletes runs warm. If a prior run wrote files that have since been deleted
	// from source (or the cache is invalid / version-stale and we fall back to
	// a cold run), those stale files survive into the redirected $path mount.
	// Single-package prepares avoid this by rmSync-ing COVERAGE_DIR before
	// instrumenting; workspace must nuke its own per-package shadow root for
	// symmetry.
	it("should name the workspace manifest when it discards a malformed one", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
			...fooProject({
				$className: "DataModel",
				ReplicatedStorage: { Pkg: { $path: "out" } },
			}),
			[FOO_MANIFEST_PATH]: "{",
			[path.join(FOO_DIR, "out/init.luau")]: "local x = 1",
		});
		const stderrText = captureStderr();

		prepareFoo({ fileSystem, instrumenter: createInstrumenter() });

		expect(stderrText()).toContain("Warning: Workspace coverage manifest is malformed JSON");
	});

	it("should remove stale shadow files when running cold (no cache)", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		const packageShadow = FOO_SHADOW;
		const staleSpecPath = path.join(packageShadow, "out/stale.spec.luau");

		volume.fromJSON({
			...fooProject({
				$className: "DataModel",
				ReplicatedStorage: { Pkg: { $path: "out" } },
			}),
			[path.join(FOO_DIR, "out/init.luau")]: "local x = 1",
			[path.join(FOO_DIR, "out/live.spec.luau")]: "return {}",
			// Stale spec from a prior run; source has no matching file.
			[staleSpecPath]: "return {}",
		});
		const instrumenter = createInstrumenter();

		prepareFoo({ fileSystem, instrumenter });

		// Stale shadow file gone: rmSync of the package shadow before the run
		// writes anything into it.
		expect(volume.existsSync(staleSpecPath)).toBeFalse();
		// Current source still landed, through the mirror sync.
		expect(volume.existsSync(path.join(packageShadow, "out/live.spec.luau"))).toBeTrue();
	});

	it("should bypass a full cache hit when the descriptor opts out via per-pkg coverageCache", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedCachedOut(volume, { manifest: cachedOutManifest({}), shadowOutputs: true });

		const [result] = prepareFoo({
			descriptor: { coverageCache: false },
			fileSystem,
		});

		expect(
			result!.manifest.files[posixPath(path.join(FOO_DIR, "out/init.luau"))]!.sourceHash,
		).toBe(sha256(OUT_SOURCE));
		expect(volume.readFileSync(`${FOO_SHADOW}/out/init.luau`, "utf8")).toContain("__cov");
	});

	it("should discard a manifest whose coverage universe no longer matches", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedCachedOut(volume, {
			manifest: cachedOutManifest({ coverageUniverseHash: "a-different-universe" }),
			shadowOutputs: false,
		});

		const [result] = prepareFoo({
			descriptor: { collectCoverageFrom: ["out/**"] },
			fileSystem,
		});

		expect(
			result!.manifest.files[posixPath(path.join(FOO_DIR, "out/init.luau"))]!.sourceHash,
		).toBe(sha256(OUT_SOURCE));
		expect(volume.readFileSync(`${FOO_SHADOW}/out/init.luau`, "utf8")).toContain("__cov");
	});

	it("should discard a manifest with a stale instrumenter version", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedCachedOut(volume, {
			manifest: cachedOutManifest({ instrumenterVersion: INSTRUMENTER_VERSION - 1 }),
			shadowOutputs: false,
		});

		const [result] = prepareFoo({ fileSystem });

		expect(
			result!.manifest.files[posixPath(path.join(FOO_DIR, "out/init.luau"))]!.sourceHash,
		).toBe(sha256(OUT_SOURCE));
		expect(volume.readFileSync(`${FOO_SHADOW}/out/init.luau`, "utf8")).toContain("__cov");
	});

	it.for([
		{
			name: "malformed JSON manifest",
			body: "{",
			expectedWarning: "malformed JSON",
		},
		{
			name: "schema-invalid manifest",
			body: JSON.stringify({
				files: "not-an-object",
				version: MANIFEST_VERSION,
			}),
			expectedWarning: "is invalid",
		},
	])("should warn and discard the cache for $name", async ({ body, expectedWarning }) => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		const stderrText = captureStderr();

		seedPackage(volume, { packageDirectory: FOO_DIR });
		const manifestDirectory = path.join(
			WORKSPACE_ROOT,
			".jest-roblox/workspace/@halcyon-foo/coverage",
		);
		volume.mkdirSync(manifestDirectory, { recursive: true });
		volume.writeFileSync(path.join(manifestDirectory, "coverage-manifest.json"), body);

		const result = prepareFoo({ fileSystem });

		expect(manifestFileKeys(result[0]!.manifest)).toStrictEqual(["out/init.luau"]);

		expect(stderrText()).toContain(expectedWarning);
	});

	it("should re-instrument when the cached shadow file is missing", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedCachedOut(volume, { manifest: cachedOutManifest({}), shadowOutputs: false });

		const result = prepareFoo({ fileSystem });

		expect(manifestFileKeys(result[0]!.manifest)).toStrictEqual(["out/init.luau"]);

		expect(volume.readFileSync(`${FOO_SHADOW}/out/init.luau`, "utf8")).toContain("__cov");
	});

	it("should skip instrumentRoot on a full cache hit", async () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedCachedOut(volume, { manifest: cachedOutManifest({}), shadowOutputs: true });
		const instrumenter = createInstrumenter();

		const [result] = prepareFoo({ fileSystem, instrumenter });

		expect(instrumenter).not.toHaveBeenCalled();
		expect(result!.manifest.files).toStrictEqual(cachedOutManifest({}).files);
		expect(volume.readFileSync(`${FOO_SHADOW}/out/init.luau`, "utf8")).toBe("instrumented");
	});

	// Validate by re-copying when the shadow file is missing.
	it("should re-copy non-instrumented file when its shadow is missing", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		const helperContent = "local x = 1";
		const specContent = "return {}";
		const absoluteSourceRoot = path.join(FOO_DIR, "out-test").replaceAll("\\", "/");
		const helperKey = `${absoluteSourceRoot}/test/fixtures.luau`;
		const specKey = `${absoluteSourceRoot}/src/foo.spec.luau`;
		const packageShadow = FOO_SHADOW;
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
			// for the helper), but the spec's shadow file does NOT exist.
			[`${packageShadow}/out-test/test/fixtures.luau`]: "instrumented",
			...fooProject({
				$className: "DataModel",
				ReplicatedStorage: { Tests: { $path: "out-test" } },
			}),
			[FOO_MANIFEST_PATH]: JSON.stringify(previousManifest),
			[path.join(FOO_DIR, "out-test/src/foo.spec.luau")]: specContent,
			[path.join(FOO_DIR, "out-test/test/fixtures.luau")]: helperContent,
		});
		const instrumenter = createInstrumenter();

		prepareFoo({ fileSystem, instrumenter });

		// previousRecord matched the source hash but pointed at a missing
		// shadow file. Re-copy via copyFileSync so the shadow stays
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
		seedMixedOutTest(volume);
		const instrumenter = createInstrumenter();

		const [result] = prepareFoo({ fileSystem, instrumenter });

		const manifest = readManifest(volume, result!.manifestPath);
		const specKey = `${path.join(FOO_DIR, "out-test").replaceAll("\\", "/")}/src/foo.spec.luau`;

		expect(Object.keys(manifest.nonInstrumentedFiles)).toContain(specKey);
	});

	it("should skip $path entries that escape the package directory", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		// $path: "../bar" resolves to the SIBLING package, outside FOO_DIR.
		volume.fromJSON({
			...fooProject({
				$className: "DataModel",
				ReplicatedStorage: { Escape: { $path: "../bar" } },
			}),
			[path.join(BAR_DIR, "init.luau")]: "local x = 1",
		});
		const instrumenter = createInstrumenter();

		expect(() => {
			return prepareFoo({ fileSystem, instrumenter });
		}).toThrow('Could not determine luauRoots for package "@halcyon/foo"');
	});

	it("should skip $path entries that do not exist on disk", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
			...fooProject({
				$className: "DataModel",
				ReplicatedStorage: { Missing: { $path: "does-not-exist" } },
			}),
		});
		const instrumenter = createInstrumenter();

		expect(() => {
			return prepareFoo({ fileSystem, instrumenter });
		}).toThrow('Could not determine luauRoots for package "@halcyon/foo"');
	});

	it("should skip $path entries matching coveragePathIgnorePatterns", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, {
			luauRoots: ["node_modules"],
			packageDirectory: FOO_DIR,
			rojoTree: {
				$className: "DataModel",
				ReplicatedStorage: { Vendor: { $path: "node_modules" } },
			},
		});
		const instrumenter = createInstrumenter();

		expect(() => {
			return prepareFoo({ fileSystem, instrumenter });
		}).toThrow('Could not determine luauRoots for package "@halcyon/foo"');
	});

	it("should skip $path entries that resolve to files (not directories)", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
			...fooProject({
				$className: "DataModel",
				ReplicatedStorage: { Single: { $path: "init.luau" } },
			}),
			[path.join(FOO_DIR, "init.luau")]: "local x = 1",
		});
		const instrumenter = createInstrumenter();

		expect(() => {
			return prepareFoo({ fileSystem, instrumenter });
		}).toThrow('Could not determine luauRoots for package "@halcyon/foo"');
	});

	it("should skip directories that contain no .luau files", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
			...fooProject({
				$className: "DataModel",
				ReplicatedStorage: { Empty: { $path: "vendor" } },
			}),
			[path.join(FOO_DIR, "vendor/readme.txt")]: "",
			[path.join(FOO_DIR, "vendor/sub/data.json")]: "{}",
		});
		const instrumenter = createInstrumenter();

		expect(() => {
			return prepareFoo({ fileSystem, instrumenter });
		}).toThrow('Could not determine luauRoots for package "@halcyon/foo"');
	});

	it("should discover ordinary .lua files without treating unrelated files as Luau", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
			...fooProject({
				$className: "DataModel",
				ReplicatedStorage: {
					Code: { $path: "lua-code" },
					Docs: { $path: "docs" },
				},
			}),
			[path.join(FOO_DIR, "docs/module.txt")]: "not luau",
			[path.join(FOO_DIR, "lua-code/module.lua")]: "return {}",
		});

		const [result] = prepareFoo({ fileSystem });

		expect(manifestFileKeys(result!.manifest)).toStrictEqual(["lua-code/module.lua"]);

		expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual([
			"lua-code",
		]);
	});

	it("should resolve roots containing only spec and snapshot Luau files", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
			...fooProject({
				$className: "DataModel",
				ReplicatedStorage: { Tests: { $path: "out-test" } },
			}),
			[path.join(FOO_DIR, "out-test/__snapshots__/foo.spec.snap.luau")]: "",
			[path.join(FOO_DIR, "out-test/src/bar.test.luau")]: "",
			[path.join(FOO_DIR, "out-test/src/foo.spec.luau")]: "",
		});

		const result = prepareFoo({ fileSystem });

		expect(result[0]!.manifest.files).toStrictEqual({});
		expect(result[0]!.coverageRoots.map((root) => root.luauRoot)).toStrictEqual([
			posixRoot("out-test"),
		]);
	});

	it("should preserve spec files in the shadow when $path mixes specs with non-spec helpers", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedMixedOutTest(volume);
		const instrumenter = createInstrumenter();

		const result = prepareFoo({ fileSystem, instrumenter });

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
	// `$path` whose root contains a `RuntimeLib` file, the canonical marker.
	it("should skip directories containing RuntimeLib (rbxts include)", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
			...fooProject({
				$className: "DataModel",
				ReplicatedStorage: {
					Pkg: { $path: "out" },
					rbxts_include: { $path: "include" },
				},
			}),
			[path.join(FOO_DIR, "include/Promise.lua")]: "local x = 1",
			[path.join(FOO_DIR, "include/RuntimeLib.lua")]: "local x = 1",
			[path.join(FOO_DIR, "out/init.luau")]: "local x = 1",
		});

		const result = prepareFoo({ fileSystem });

		expect(manifestFileKeys(result[0]!.manifest)).toStrictEqual(["out/init.luau"]);

		expect(result[0]!.coverageRoots).toStrictEqual([
			{
				luauRoot: posixRoot("out"),
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
			...fooProject({
				$className: "DataModel",
				ReplicatedStorage: { A: { $path: "src" }, B: { $path: "src" } },
			}),
			[path.join(FOO_DIR, "src/init.luau")]: "local x = 1",
		});

		const result = prepareFoo({ fileSystem });

		expect(manifestFileKeys(result[0]!.manifest)).toStrictEqual(["src/init.luau"]);
	});

	it("should treat an empty coveragePathIgnorePatterns list as ignoring nothing", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, { packageDirectory: FOO_DIR });

		const result = prepareFoo({ fileSystem });

		expect(manifestFileKeys(result[0]!.manifest)).toStrictEqual(["out/init.luau"]);
	});

	it("should require explicit luauRoots to correspond to collected rojo mounts", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, {
			luauRoots: ["unmounted"],
			packageDirectory: FOO_DIR,
		});
		const stderrText = captureStderr();
		const instrumenter = createInstrumenter();

		expect(() => {
			return prepareFoo({
				descriptor: { luauRoots: ["unmounted"] },
				fileSystem,
				instrumenter,
			});
		}).toThrow('Could not determine luauRoots for package "@halcyon/foo"');
		expect(stderrText()).toBe(
			'Warning: luauRoot "unmounted" in @halcyon/foo does not correspond to any rojo $path mount, so it reports no coverage.\n',
		);
	});

	it("should reject package-root, parent, and unrelated paths as explicit rojo mounts", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		const outsideDirectory = path.join(WORKSPACE_ROOT, "outside");
		volume.fromJSON({
			...fooProject({
				$className: "DataModel",
				ReplicatedStorage: {
					Outside: { $path: outsideDirectory },
					Parent: { $path: "../bar" },
					Root: { $path: "." },
				},
			}),
			[path.join(BAR_DIR, "init.luau")]: "return {}",
			[path.join(FOO_DIR, "init.luau")]: "return {}",
			[path.join(outsideDirectory, "init.luau")]: "return {}",
		});
		const stderrText = captureStderr();
		const instrumenter = createInstrumenter();

		expect(() => {
			return prepareFoo({
				descriptor: { luauRoots: [".", "../bar", outsideDirectory] },
				fileSystem,
				instrumenter,
			});
		}).toThrow('Could not determine luauRoots for package "@halcyon/foo"');
		expect(stderrText()).toBe(
			[".", "../bar", outsideDirectory]
				.map((root) => {
					return `Warning: luauRoot "${root}" in @halcyon/foo is not a directory inside the package, so it reports no coverage.\n`;
				})
				.join(""),
		);
	});

	it("should not treat the package-root rojo path as a coverage root", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
			...fooProject({
				$className: "DataModel",
				ReplicatedStorage: {
					Out: { $path: "out" },
					Root: { $path: "." },
				},
			}),
			[path.join(FOO_DIR, "init.luau")]: "return {}",
			[path.join(FOO_DIR, "out/init.luau")]: "return {}",
		});

		const result = prepareFoo({ fileSystem });

		expect(manifestFileKeys(result[0]!.manifest)).toStrictEqual(["out/init.luau"]);
	});

	it("should apply ignore patterns within a mounted path", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, {
			luauRoots: ["out/generated"],
			packageDirectory: FOO_DIR,
			rojoTree: {
				$className: "DataModel",
				ReplicatedStorage: { Generated: { $path: "out/generated" } },
			},
		});
		const instrumenter = createInstrumenter();

		expect(() => {
			return prepareFoo({
				descriptor: { coveragePathIgnorePatterns: ["generated"] },
				fileSystem,
				instrumenter,
			});
		}).toThrow('Could not determine luauRoots for package "@halcyon/foo"');
	});

	it("should use tsconfig output roots when no Rojo mount supplies roots", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON({
			...fooProject({ $className: "DataModel" }),
			[path.join(FOO_DIR, "out/init.luau")]: "return {}",
		});
		const instrumenter = createInstrumenter();
		const [result] = prepare({
			cacheDirectory: CACHE_DIRECTORY,
			fileSystem,
			instrumenter,
			packages: [
				{ name: "@halcyon/foo", packageDirectory: FOO_DIR, rojoProjectPath: FOO_PROJECT },
			],
			tsconfigReader: () => {
				return {
					config: { compilerOptions: { outDir: "out" } },
					path: path.join(FOO_DIR, "tsconfig.json"),
				};
			},
		});

		expect(result!.coverageRoots.map((root) => root.luauRoot)).toStrictEqual([
			posixRoot("out"),
		]);
	});

	it("should reject packages with no roots and name the package", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.fromJSON(fooProject({ $className: "DataModel" }));

		expect(() => {
			return prepare({
				cacheDirectory: CACHE_DIRECTORY,
				fileSystem,
				instrumenter: createInstrumenter(),
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory: FOO_DIR,
						rojoProjectPath: FOO_PROJECT,
					},
				],
				tsconfigReader: () => null,
			});
		}).toThrow('Could not determine luauRoots for package "@halcyon/foo"');
	});

	// Workspace coverage walked every rojo `$path` mount and
	// instrumented every directory containing luau files, ignoring per-pkg
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
				...fooProject(multiMountTree),
				[path.join(FOO_DIR, "src/init.luau")]: "local x = 1",
				[path.join(FOO_DIR, "vendored-packages/dep/init.luau")]: "local y = 2",
			});
		}

		function rebuildOverPriorManifest({
			fileSystem,
			manifest,
			staleShadow,
			volume,
		}: {
			fileSystem: FileSystem;
			manifest: CoverageManifest;
			staleShadow: string;
			volume: MemoryVolume;
		}): void {
			seedMultiMount(volume);
			volume.fromJSON({
				[FOO_MANIFEST_PATH]: JSON.stringify(manifest),
				[staleShadow]: "return {}",
			});
			prepareFoo({
				descriptor: { luauRoots: ["src"] },
				fileSystem,
				instrumenter: createInstrumenter(),
			});
		}

		it("should short-circuit to descriptor.luauRoots when set, ignoring other rojo $path mounts", async () => {
			expect.assertions(3);

			const { fileSystem, volume } = createMemoryFileSystem();
			seedMultiMount(volume);

			const [result] = prepareFoo({
				descriptor: { luauRoots: ["src"] },
				fileSystem,
			});

			expect(manifestFileKeys(result!.manifest)).toStrictEqual(["src/init.luau"]);

			expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual([
				"src",
			]);

			const manifest = readManifest(volume, result!.manifestPath);

			expect(manifest.luauRoots).toHaveLength(1);
		});

		it("should walk every $path when descriptor.luauRoots is undefined", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			seedMultiMount(volume);

			const [result] = prepareFoo({ fileSystem });

			expect(manifestFileKeys(result!.manifest)).toStrictEqual([
				"src/init.luau",
				"vendored-packages/dep/init.luau",
			]);

			expect(
				result!.coverageRoots.map((entry): string => entry.luauRoot).sort(),
			).toStrictEqual(["src", "vendored-packages"]);
		});

		it("should drop off-tree luauRoot entries with a stderr warning", async () => {
			expect.assertions(3);

			const { fileSystem, volume } = createMemoryFileSystem();
			seedMultiMount(volume);

			const stderrText = captureStderr();

			expect(() => {
				return prepareFoo({
					descriptor: { luauRoots: ["build/out"] },
					fileSystem,
				});
			}).toThrow('Could not determine luauRoots for package "@halcyon/foo"');

			expect(volume.existsSync(FOO_MANIFEST_PATH)).toBeFalse();

			expect(stderrText()).toContain('luauRoot "build/out" in @halcyon/foo');
		});

		it("should fall through to the rojo walk when descriptor.luauRoots is an empty array", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();
			seedMultiMount(volume);

			const result = prepareFoo({ descriptor: { luauRoots: [] }, fileSystem });

			expect(manifestFileKeys(result[0]!.manifest)).toStrictEqual([
				"src/init.luau",
				"vendored-packages/dep/init.luau",
			]);
		});

		it("should honor per-pkg coveragePathIgnorePatterns over the defaults", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			seedMultiMount(volume);

			const [result] = prepareFoo({
				descriptor: { coveragePathIgnorePatterns: ["**/vendored-packages/**"] },
				fileSystem,
			});

			expect(manifestFileKeys(result!.manifest)).toStrictEqual(["src/init.luau"]);

			expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual([
				"src",
			]);
		});

		it("should honor per-pkg coverageCopyIgnorePatterns over the defaults", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			seedMultiMount(volume);
			volume.writeFileSync(path.join(FOO_DIR, "src/notes.md"), "keep me");
			volume.writeFileSync(path.join(FOO_DIR, "src/build.tsbuildinfo"), "{}");
			const instrumenter = createInstrumenter();

			const [result] = prepareFoo({
				descriptor: {
					coverageCopyIgnorePatterns: ["**/*.tsbuildinfo"],
					luauRoots: ["src"],
				},
				fileSystem,
				instrumenter,
			});

			const mirrored = Object.keys(result!.manifest.nonInstrumentedFiles);

			expect(mirrored.some((entry) => entry.endsWith("src/notes.md"))).toBeTrue();
			expect(mirrored.some((entry) => entry.endsWith(".tsbuildinfo"))).toBeFalse();
		});

		it("should rebuild a package cold when its copy-ignore list changed", async () => {
			expect.assertions(3);

			const { fileSystem, volume } = createMemoryFileSystem();

			const packageShadow = FOO_SHADOW;
			const fileKey = `${path.join(FOO_DIR, "src").replaceAll("\\", "/")}/init.luau`;
			const mirroredKey = `${path.join(FOO_DIR, "src").replaceAll("\\", "/")}/build.tsbuildinfo`;
			const previousManifest: CoverageManifest = {
				buildId: "prev-build-id",

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

			volume.writeFileSync(`${packageShadow}/src/init.cov-map.json`, "{}");

			const [result] = prepareFoo({
				descriptor: {
					coverageCopyIgnorePatterns: ["**/*.tsbuildinfo"],
					luauRoots: ["src"],
				},
				fileSystem,
			});

			expect(volume.readFileSync(`${packageShadow}/src/init.luau`, "utf8")).toContain(
				"__cov",
			);
			expect(result!.manifest.nonInstrumentedFiles).not.toHaveProperty(mirroredKey);

			expect(manifestFileKeys(result!.manifest)).toStrictEqual(["src/init.luau"]);
		});

		it("should instrument every mount when the descriptor opts out of every pattern via an empty array", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			seedMultiMount(volume);

			const [result] = prepareFoo({
				descriptor: { coveragePathIgnorePatterns: [] },
				fileSystem,
			});

			expect(manifestFileKeys(result!.manifest)).toStrictEqual([
				"src/init.luau",
				"vendored-packages/dep/init.luau",
			]);

			expect(
				result!.coverageRoots.map((entry): string => entry.luauRoot).sort(),
			).toStrictEqual(["src", "vendored-packages"]);
		});

		it("should take a luauRoot nested below the $path mount that covers it", async () => {
			expect.assertions(4);

			const { fileSystem, volume } = createMemoryFileSystem();

			volume.fromJSON({
				...fooProject({
					$className: "DataModel",
					ReplicatedStorage: { Src: { $path: "src" } },
				}),
				[path.join(FOO_DIR, "src/client/init.luau")]: "local x = 1",
			});
			const stderrText = captureStderr();

			const [result] = prepareFoo({
				descriptor: { luauRoots: ["src/client"] },
				fileSystem,
			});

			expect(manifestFileKeys(result!.manifest)).toStrictEqual(["src/client/init.luau"]);

			expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual([
				"src/client",
			]);
			expect(result!.coverageSpine.map((entry): string => entry.luauRoot)).toStrictEqual([
				"src",
			]);
			expect(stderrText()).toBe("");
		});

		it.for([
			{
				mounts: { ASrc: { $path: "src" }, BClient: { $path: "src/client" } },
				order: "shallow-first",
			},
			{
				mounts: { AClient: { $path: "src/client" }, BSrc: { $path: "src" } },
				order: "deep-first",
			},
		])(
			"should demote the deepest containing mount when declared $order",
			async ({ mounts }) => {
				expect.assertions(1);

				const { fileSystem, volume } = createMemoryFileSystem();
				volume.fromJSON({
					...fooProject({ $className: "DataModel", ReplicatedStorage: mounts }),
					[path.join(FOO_DIR, "src/client/ui/init.luau")]: "local x = 1",
				});
				const instrumenter = createInstrumenter();

				const [result] = prepareFoo({
					descriptor: { luauRoots: ["src/client/ui"] },
					fileSystem,
					instrumenter,
				});

				expect(result!.coverageSpine.map((entry): string => entry.luauRoot)).toStrictEqual([
					"src/client",
				]);
			},
		);

		it("should reject a luauRoot that escapes the package through a traversal", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			// Spelled with no leading `..`, so only resolving it reveals that it
			// lands outside the package, on a directory the rojo tree really
			// does mount, so reachability alone would wave it through.
			volume.fromJSON({
				...fooProject({
					$className: "DataModel",
					ReplicatedStorage: { Bar: { $path: "../bar" } },
				}),
				[path.join(BAR_DIR, "init.luau")]: "local x = 1",
			});
			const stderrText = captureStderr();
			const instrumenter = createInstrumenter();

			expect(() => {
				return prepareFoo({
					descriptor: { luauRoots: ["src/../../bar"] },
					fileSystem,
					instrumenter,
				});
			}).toThrow('Could not determine luauRoots for package "@halcyon/foo"');

			expect(stderrText()).toBe(
				'Warning: luauRoot "src/../../bar" in @halcyon/foo is not a directory inside the package, so it reports no coverage.\n',
			);
		});

		it("should reject a traversal that resolves back to the package root", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			volume.fromJSON({
				...fooProject({
					$className: "DataModel",
					ReplicatedStorage: { Root: { $path: "." } },
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "local x = 1",
			});
			const stderrText = captureStderr();
			const instrumenter = createInstrumenter();

			expect(() => {
				return prepareFoo({
					descriptor: { luauRoots: ["src/.."] },
					fileSystem,
					instrumenter,
				});
			}).toThrow('Could not determine luauRoots for package "@halcyon/foo"');

			expect(stderrText()).toBe(
				'Warning: luauRoot "src/.." in @halcyon/foo is not a directory inside the package, so it reports no coverage.\n',
			);
		});

		it("should accept a directory whose name merely starts with two dots", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();

			volume.fromJSON({
				...fooProject({
					$className: "DataModel",
					ReplicatedStorage: { Cache: { $path: "..cache" } },
				}),
				[path.join(FOO_DIR, "..cache/init.luau")]: "local x = 1",
			});

			const [result] = prepareFoo({
				descriptor: { luauRoots: ["..cache"] },
				fileSystem,
			});

			expect(manifestFileKeys(result!.manifest)).toStrictEqual(["..cache/init.luau"]);

			expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual([
				"..cache",
			]);
		});

		it("should reject an empty luauRoot, which names the package itself", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			volume.fromJSON({
				...fooProject({
					$className: "DataModel",
					ReplicatedStorage: { Src: { $path: "src" } },
				}),
				[path.join(FOO_DIR, "src/init.luau")]: "local x = 1",
			});
			const stderrText = captureStderr();
			const instrumenter = createInstrumenter();

			expect(() => {
				return prepareFoo({ descriptor: { luauRoots: [""] }, fileSystem, instrumenter });
			}).toThrow('Could not determine luauRoots for package "@halcyon/foo"');
			expect(stderrText()).toBe(
				'Warning: luauRoot "" in @halcyon/foo is not a directory inside the package, so it reports no coverage.\n',
			);
		});

		it("should accept a luauRoot nested below one mount when a finer mount lands on it", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();

			volume.fromJSON({
				...fooProject({
					$className: "DataModel",
					ReplicatedStorage: {
						Client: { $path: "src/client" },
						Src: { $path: "src" },
					},
				}),
				[path.join(FOO_DIR, "src/client/init.luau")]: "local x = 1",
			});

			const [result] = prepareFoo({
				descriptor: { luauRoots: ["src/client"] },
				fileSystem,
			});

			expect(manifestFileKeys(result!.manifest)).toStrictEqual(["src/client/init.luau"]);

			expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual([
				"src/client",
			]);
		});

		it("should accept a luauRoot that contains a finer-grained $path mount", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();

			volume.fromJSON({
				...fooProject({
					$className: "DataModel",
					ReplicatedStorage: { Client: { $path: "src/client" } },
				}),
				[path.join(FOO_DIR, "src/client/init.luau")]: "local y = 2",
				[path.join(FOO_DIR, "src/init.luau")]: "local x = 1",
			});

			const [result] = prepareFoo({
				descriptor: { luauRoots: ["src"] },
				fileSystem,
			});

			expect(manifestFileKeys(result!.manifest)).toStrictEqual([
				"src/client/init.luau",
				"src/init.luau",
			]);

			expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual([
				"src",
			]);
		});

		it("should deduplicate repeated luauRoots entries", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			seedMultiMount(volume);

			const [result] = prepareFoo({
				descriptor: { luauRoots: ["src", "src"] },
				fileSystem,
			});

			expect(manifestFileKeys(result!.manifest)).toStrictEqual(["src/init.luau"]);

			expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual([
				"src",
			]);
		});

		it("should skip a luauRoot that is on the rojo tree but has no instrumentable files", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();

			volume.fromJSON({
				...fooProject({
					$className: "DataModel",
					ReplicatedStorage: {
						Empty: { $path: "empty" },
						Src: { $path: "src" },
					},
				}),
				[path.join(FOO_DIR, "empty/README.md")]: "not a luau file",
				[path.join(FOO_DIR, "src/init.luau")]: "local x = 1",
			});

			const [result] = prepareFoo({
				descriptor: { luauRoots: ["empty", "src"] },
				fileSystem,
			});

			expect(manifestFileKeys(result!.manifest)).toStrictEqual(["src/init.luau"]);

			expect(result!.coverageRoots.map((entry): string => entry.luauRoot)).toStrictEqual([
				"src",
			]);
		});

		it("should cold-rebuild the shadow when luauRoots shrinks between runs", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			const packageShadow = FOO_SHADOW;
			const staleVendoredShadow = path.join(packageShadow, "vendored-packages/dep/init.luau");
			const sourceFileKey = `${path.join(FOO_DIR, "src").replaceAll("\\", "/")}/init.luau`;
			const vendoredShadowDirectory = path.join(packageShadow, "vendored-packages");
			// Prior run instrumented BOTH mounts; the new run only lists
			// `src`.
			const previousManifest = priorRootsManifest({
				content: "local x = 1",
				fileKey: sourceFileKey,
				luauRoots: [
					path.join(packageShadow, "src").replaceAll("\\", "/"),
					path.join(packageShadow, "vendored-packages").replaceAll("\\", "/"),
				],
			});

			// Stale shadow file from the prior mount that the new run drops.
			rebuildOverPriorManifest({
				fileSystem,
				manifest: previousManifest,
				staleShadow: staleVendoredShadow,
				volume,
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
			const packageShadow = FOO_SHADOW;
			const staleVendoredShadow = path.join(packageShadow, "vendored-packages/dep/init.luau");
			const previousFileKey = `${path.join(FOO_DIR, "vendored-packages").replaceAll("\\", "/")}/dep/init.luau`;
			const previousManifest = priorRootsManifest({
				content: "local y = 2",
				fileKey: previousFileKey,
				luauRoots: [path.join(packageShadow, "vendored-packages").replaceAll("\\", "/")],
			});

			rebuildOverPriorManifest({
				fileSystem,
				manifest: previousManifest,
				staleShadow: staleVendoredShadow,
				volume,
			});

			expect(volume.existsSync(staleVendoredShadow)).toBeFalse();
		});

		it("should preserve the cache when luauRoots is unchanged between runs", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();
			// Cache hit with matching luauRoots set: prior shadow survives and
			// `useIncremental` stays `true`. Exercises the
			// `setsEqual === true` branch.
			const packageShadow = FOO_SHADOW;
			const fileKey = `${path.join(FOO_DIR, "out").replaceAll("\\", "/")}/init.luau`;
			const previousManifest = priorRootsManifest({
				content: "local x = 1",
				fileKey,
				luauRoots: ["out"],
			});

			seedPackage(volume, { packageDirectory: FOO_DIR });
			volume.fromJSON({
				[path.join(packageShadow, "coverage-manifest.json")]:
					JSON.stringify(previousManifest),
				// A sidecar marker: reconciliation keeps it (its base
				// `init.luau` source exists), but a cold rmSync would wipe it and
				// no mirror pass can restore it (sidecars aren't in source). So
				// its survival proves the shadow was preserved, not rebuilt.
				[path.join(packageShadow, "out/init.cov-map.json")]: "{}",
			});
			const instrumenter = createInstrumenter();

			prepareFoo({ fileSystem, instrumenter });

			// Cache preserved → rmSync did not fire, the sidecar is still there.
			expect(volume.existsSync(path.join(packageShadow, "out/init.cov-map.json"))).toBeTrue();
		});

		it("should skip rojo $path entries that escape the package directory", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();
			// `..` path escapes the package: the relative path starts with
			// "..", which `buildRojoMountSet` drops. Combined with a per-pkg
			// `luauRoots` that lists the absolute-equivalent root, this
			// confirms the off-tree filter and the warning fire.
			volume.fromJSON({
				...fooProject({
					$className: "DataModel",
					ReplicatedStorage: { External: { $path: "../sibling" } },
				}),
				[path.join(WORKSPACE_ROOT, "sibling/init.luau")]: "local x = 1",
			});
			const instrumenter = createInstrumenter();
			const stderrText = captureStderr();

			expect(() => {
				return prepareFoo({
					descriptor: { luauRoots: ["sibling"] },
					fileSystem,
					instrumenter,
				});
			}).toThrow('Could not determine luauRoots for package "@halcyon/foo"');

			expect(stderrText()).toContain('luauRoot "sibling" in @halcyon/foo');
		});
	});
});

describe(emitWorkspaceBuildManifests, () => {
	it("should preserve build identity and manifest bytes when the place is reused", () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, { packageDirectory: FOO_DIR });
		const instrumenter = createInstrumenter();
		const entries = prepareFoo({ fileSystem, instrumenter });
		emitWorkspaceBuildManifests({
			coveragePlace: SHARED_PLACE,
			entries,
			fileSystem,
			rebuilt: true,
		});
		const first = entries[0]!.manifest;
		const buildPath = path.join(path.dirname(entries[0]!.manifestPath), "build-manifest.json");
		const bytes = volume.readFileSync(buildPath, "utf8");
		const second = prepareFoo({ fileSystem, instrumenter });
		emitWorkspaceBuildManifests({
			coveragePlace: SHARED_PLACE,
			entries: second,
			fileSystem,
			rebuilt: false,
		});

		expect(second[0]!.manifest.buildId).toBe(first.buildId);
		expect(second[0]!.manifest.generatedAt).toBe(first.generatedAt);
		expect(volume.readFileSync(buildPath, "utf8")).toBe(bytes);
	});

	it("should write a build-manifest.json next to each package's coverage-manifest.json", async () => {
		expect.assertions(5);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, { packageDirectory: FOO_DIR });
		const instrumenter = createInstrumenter();

		const entries = prepareFoo({ fileSystem, instrumenter });
		const priorId = entries[0]!.manifest.buildId;
		entries[0]!.manifest.generatedAt = "2025-01-01T00:00:00.000Z";

		emitWorkspaceBuildManifests({
			coveragePlace: SHARED_PLACE,
			entries,
			fileSystem,
			rebuilt: true,
		});

		const buildManifestPath = path.join(
			WORKSPACE_ROOT,
			".jest-roblox/workspace/@halcyon-foo/coverage/build-manifest.json",
		);

		const manifest = fromAny<BuildManifest, JSONValue>(
			JSON.parse(volume.readFileSync(buildManifestPath, "utf-8").toString()),
		);

		expect(manifest.buildId).toBe(entries[0]!.manifest.buildId);
		expect(manifest.buildId).not.toBe(priorId);
		expect(manifest.generatedAt).not.toBe("2025-01-01T00:00:00.000Z");
		expect(manifest.coveragePlace).toStrictEqual(SHARED_PLACE);
		expect(manifest.cleanPlace).toBeUndefined();
	});

	it("should emit an independent build manifest per package over the one shared place", async () => {
		expect.assertions(5);

		const { fileSystem, volume } = createMemoryFileSystem();
		seedPackage(volume, { packageDirectory: FOO_DIR });
		seedPackage(volume, { packageDirectory: BAR_DIR });
		const instrumenter = createInstrumenter();

		const entries = prepare({
			cacheDirectory: CACHE_DIRECTORY,
			fileSystem,
			instrumenter,
			packages: [
				{
					name: "@halcyon/foo",
					packageDirectory: FOO_DIR,
					rojoProjectPath: FOO_PROJECT,
				},
				{
					name: "@halcyon/bar",
					packageDirectory: BAR_DIR,
					rojoProjectPath: BAR_PROJECT,
				},
			],
		});

		emitWorkspaceBuildManifests({
			coveragePlace: SHARED_PLACE,
			entries,
			fileSystem,
			rebuilt: true,
		});

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
		seedPackage(volume, { packageDirectory: FOO_DIR });
		const instrumenter = createInstrumenter();

		const entries = prepareFoo({ fileSystem, instrumenter });

		emitWorkspaceBuildManifests({
			coveragePlace: SHARED_PLACE,
			entries,
			fileSystem,
			rebuilt: true,
		});

		const manifest = readPackageBuildManifest(volume, "@halcyon-foo");
		const expectedKey = `${path.join(FOO_DIR, "out").replaceAll("\\", "/")}/init.luau`;

		expect(manifest.files).toStrictEqual({
			[expectedKey]: { sourceHash: "deadbeef" },
		});
		expect(manifest.projects).toStrictEqual([]);
	});
});

function readPackageBuildManifest(volume: MemoryVolume, safeName: string): BuildManifest {
	const buildManifestPath = path.join(
		WORKSPACE_ROOT,
		`.jest-roblox/workspace/${safeName}/coverage/build-manifest.json`,
	);
	return fromAny<BuildManifest, JSONValue>(
		JSON.parse(volume.readFileSync(buildManifestPath, "utf-8").toString()),
	);
}

describe("narrowing a workspace package to its coverage universe", () => {
	/**
	 * A package whose probes all sit in one subtree below its rojo mount.
	 * @param volume - Volume the package is written to.
	 */
	function seedNarrowablePackage(volume: MemoryVolume): void {
		volume.fromJSON({
			...fooProject({
				$className: "DataModel",
				ReplicatedStorage: { Pkg: { $path: "out" } },
			}),
			[path.join(FOO_DIR, "out/client/button.luau")]: "local x = 1",
			[path.join(FOO_DIR, "out/loose.luau")]: "local x = 2",
			[path.join(FOO_DIR, "out/modules/ecs/world.luau")]: "local x = 3",
			[path.join(FOO_DIR, "out/modules/net.luau")]: "local x = 4",
		});
	}

	function prepareNarrowed(
		fileSystem: FileSystem,
		instrumenter: Instrumenter,
	): ReturnType<typeof prepareWorkspaceCoverage> {
		return prepareFoo({
			descriptor: { collectCoverageFrom: ["**/ecs/**"] },
			fileSystem,
			instrumenter,
		});
	}

	it("should instrument the narrowed root rather than the whole mount", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedNarrowablePackage(volume);
		const instrumenter = createInstrumenter();

		const [result] = prepareNarrowed(fileSystem, instrumenter);

		expect(result!.coverageRoots.map((root): string => root.luauRoot)).toStrictEqual([
			"out/modules/ecs",
		]);
	});

	it("should name the demoted mount and carry its loose files onto the spine", async () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedNarrowablePackage(volume);
		const instrumenter = createInstrumenter();

		const [result] = prepareNarrowed(fileSystem, instrumenter);

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
			posixPath(path.join(FOO_DIR, "out/loose.luau")),
		);
	});
});

describe("workspace-mode $path containment", () => {
	const packageDirectory = posixRoot(path.resolve("/pkg"));
	const packageProject = `${packageDirectory}/test.project.json`;

	it("should reject a mount outside the package", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[packageProject]: JSON.stringify({
				name: "test",
				tree: { $className: "DataModel", ReplicatedStorage: { $path: "../outside/out" } },
			}),
		});

		expect(() => {
			return prepare({
				cacheDirectory: "/cache",
				fileSystem,
				packages: [{ name: "pkg", packageDirectory, rojoProjectPath: packageProject }],
				tsconfigReader: () => null,
			});
		}).toThrow('Could not determine luauRoots for package "pkg"');
	});

	it.for([
		{
			mount: `${packageDirectory}/out`,
			roots: ["out"],
			shape: "an absolute mount inside",
		},
	])("should answer $roots for $shape the frame", async ({ mount, roots }) => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		const frameDirectories = [
			`${packageDirectory}/out`,
			"/outside/out",
			path.resolve("../outside/out"),
		];
		volume.fromJSON({
			...Object.fromEntries(
				frameDirectories.map((directory) => [`${directory}/init.luau`, "local x = 1"]),
			),
			[packageProject]: JSON.stringify({
				name: "test",
				tree: { $className: "DataModel", ReplicatedStorage: { $path: mount } },
			}),
		});

		const [workspace] = prepare({
			cacheDirectory: path.join(packageDirectory, ".jest-roblox/workspace"),
			fileSystem,
			instrumenter: createInstrumenter(),
			packages: [{ name: "pkg", packageDirectory, rojoProjectPath: packageProject }],
		});

		expect(workspace!.coverageRoots.map((root) => root.luauRoot)).toStrictEqual(
			roots.map(posixRoot),
		);
	});
});
