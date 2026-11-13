import { fromAny } from "@total-typescript/shoehorn";

import { type } from "arktype";
import * as crypto from "node:crypto";
import * as path from "node:path";
import process from "node:process";
import type { Except } from "type-fest";
import { describe, expect, it, vi } from "vitest";

import { writeAgedFile } from "#test/mocks/aged-file.ts";
import { copyIgnoreHash as digestCopyIgnore } from "#test/mocks/coverage-hash.ts";
import { rojoInputsHash } from "#test/mocks/coverage-prepare-rojo-hash.ts";
import { stubBake } from "#test/mocks/coverage-prepare-stub-bake.ts";
import {
	makeConfig,
	PROJECT_DIR,
	readingOutDirectory,
	seedFilesystem,
	seedInto,
} from "#test/mocks/coverage-spec-prepare-seed.ts";
import {
	BUILD_MANIFEST_VERSION,
	INSTRUMENTER_VERSION,
	MANIFEST_VERSION,
} from "#test/mocks/coverage-versions.ts";
import type { MemoryVolume } from "#test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { movableClockCollector, tickingClockCollector } from "#test/mocks/movable-clock.ts";
import { posixPath } from "#test/mocks/posix-path.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { writingRojoExec } from "#test/mocks/rojo-exec.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { BuildManifestProject } from "../coverage-data/build-manifest.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
} from "../coverage-data/manifest.ts";
import type { Instrumenter } from "../instrument/instrumenter.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PrepareCoverageResult } from "./prepare-types.ts";
import { prepareCoverageAsync, toCoverageArtifacts } from "./prepare.ts";
import type { ShadowBake, ShadowLayout } from "./spine.ts";

const DEFAULT_COPY_IGNORE_HASH = digestCopyIgnore(
	createResolvedConfig().coverageCopyIgnorePatterns,
);

const COVERED_FILE = "out-tsc/test/init.luau";
const UNCOVERED_FILE = "out-tsc/test/ui/button.luau";

function isoNow(): string {
	const now = new Date();
	return now.toISOString();
}

function readRojoProjectJson(volume: MemoryVolume, filePath: string): JSONValue {
	const parsed = JSON.parse(volume.readFileSync(filePath, "utf-8").toString());
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Expected rojo project to be a JSON object");
	}

	return parsed;
}

/**
 * Walks a nested plain-object tree by key, so a test can reach into a parsed
 * rojo project without asserting a shape onto it. Lives at module scope; the
 * per-key guard would otherwise be a conditional inside a test body.
 * @param source - Parsed tree to walk.
 * @param keys - Property names, outermost first.
 * @returns The value at the path, or `undefined` when a level is missing.
 */
function readNestedProperty(source: JSONValue, ...keys: Array<string>): JSONValue | undefined {
	let current: JSONValue | undefined = source;
	for (const key of keys) {
		if (current === null || typeof current !== "object" || Array.isArray(current)) {
			throw new Error(`Expected an object while reading "${keys.join(".")}"`);
		}

		current = current[key];
	}

	return current;
}

/** What every case that never reaches the tsconfig fallback hands in. */
const noTsconfig = readingOutDirectory();

type ExecCallback = (cause: Error | null, stdout: string, stderr: string) => void;
type RojoExec = (
	file: string,
	args: Array<string>,
	options: object,
	callback: ExecCallback,
) => void;

interface WrittenManifest {
	buildId: string;
	luauRoots: Array<string>;
	rojoInputsHash?: string;
	version: number;
}

function setupMocks(volume: MemoryVolume, { outDir }: { outDir?: string } = {}) {
	const tsconfigReader = readingOutDirectory(outDir);
	const instrumenter = vi.fn<Instrumenter>().mockReturnValue({});

	const execFile = vi.fn<RojoExec>(
		writingRojoExec({ bytes: "rebuilt RBXL", fileSystem: volume }),
	);
	const childProcess: ChildProcessRunner = fromAny({ execFile });

	return { childProcess, execFile, instrumenter, tsconfigReader };
}

function seedPackageRoots(volume: MemoryVolume, secondRoot = "utils"): void {
	volume.mkdirSync("packages/core/out", { recursive: true });
	volume.mkdirSync(`packages/${secondRoot}/out`, { recursive: true });
	volume.mkdirSync(PROJECT_DIR, { recursive: true });
	volume.writeFileSync("packages/core/out/init.luau", "local a = 1");
	volume.writeFileSync(`packages/${secondRoot}/out/init.luau`, "local b = 2");
	volume.writeFileSync(
		path.join(PROJECT_DIR, "default.project.json"),
		JSON.stringify({
			name: "test",
			tree: {
				$className: "DataModel",
				ReplicatedStorage: {
					core: { $path: "packages/core/out" },
					[secondRoot]: { $path: `packages/${secondRoot}/out` },
				},
			},
		}),
	);
}

async function prepareRootAsync(
	seams: Pick<ReturnType<typeof setupMocks>, "childProcess"> & {
		fileSystem: FileSystem;
		instrumenter?: Instrumenter;
	},
): Promise<PrepareCoverageResult> {
	return prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
		...seams,
		tsconfigReader: noTsconfig,
	});
}

function captureStderr(): () => string {
	let text = "";
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		text += String(chunk);
		return true;
	});
	return () => text;
}

async function prepareSeededAsync() {
	const { fileSystem, volume } = seedFilesystem();
	const mocks = setupMocks(volume);
	const result = await prepareRootAsync({ ...mocks, fileSystem });

	return { ...mocks, fileSystem, result, volume };
}

/**
 * A bake that owns nothing, for a test that only cares what the hook does.
 * @param run - What the bake does when the run invokes it.
 * @returns A bake that claims no shadow entry.
 */
function makeBake(run: ShadowBake["run"]): ShadowBake {
	return { isBakeOwned: () => false, run, stubMounts: () => [] };
}

const writtenManifestSchema = type({
	"+": "ignore",
	"buildId": "string",
	"luauRoots": "string[]",
	"rojoInputsHash?": "string",
	"version": "number",
}).as<WrittenManifest>();

/**
 * The fields of the coverage manifest a run published that these specs read.
 *
 * @param volume - Where the run wrote it.
 * @param filePath - Where the manifest sits on the volume.
 * @returns The manifest, checked only for the fields `WrittenManifest` names.
 * @throws When the file is not JSON, lacks one of those fields, or carries
 *   another manifest version.
 */
function readCoverageManifestFile(volume: MemoryVolume, filePath: string): WrittenManifest {
	const manifest = writtenManifestSchema.assert(
		JSON.parse(volume.readFileSync(filePath, "utf-8").toString()),
	);
	if (manifest.version !== MANIFEST_VERSION) {
		throw new Error(`unexpected manifest version ${String(manifest.version)}`);
	}

	return manifest;
}

describe(prepareCoverageAsync, () => {
	it.for([
		{ collectCoverageFrom: undefined, expected: ["init.luau"] },
		{
			collectCoverageFrom: ["**/*"],
			expected: ["init.luau", "start.client.luau", "start.server.lua"],
		},
	])(
		"should select script instrumentation in single mode with include $collectCoverageFrom",
		async ({ collectCoverageFrom, expected }) => {
			expect.assertions(1);

			const { fileSystem, volume } = seedFilesystem();
			const directory = "out-tsc/test";
			volume.writeFileSync(path.join(directory, "start.client.luau"), "local x = 2");
			volume.writeFileSync(path.join(directory, "start.server.lua"), "local x = 3");
			const mocks = setupMocks(volume);
			const result = await prepareCoverageAsync(
				makeConfig({
					collectCoverageFrom,
					coveragePathIgnorePatterns: [],
					luauRoots: [directory],
				}),
				{ childProcess: mocks.childProcess, fileSystem, tsconfigReader: noTsconfig },
			);
			const files = Object.keys(result.manifest.files);

			expect(files.map((file) => path.basename(file)).sort()).toStrictEqual(expected);
		},
	);

	describe("when resolving luauRoots", () => {
		it("should use config.luauRoots when provided", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = seedFilesystem();
			const { childProcess } = setupMocks(volume);
			const result = await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			expect(Object.keys(result.manifest.files)).toStrictEqual([COVERED_FILE]);
		});

		it("should warn on stderr for each explicit root that reports no coverage", async () => {
			expect.assertions(1);

			const rootDirectory = path.resolve("/elsewhere/pkg");
			const { fileSystem, volume } = createMemoryFileSystem({
				[path.join(rootDirectory, "default.project.json")]: JSON.stringify({
					name: "test",
					tree: { $className: "DataModel", ReplicatedStorage: { $path: "out" } },
				}),
				[path.join(rootDirectory, "lib/init.luau")]: "local y = 2",
				[path.join(rootDirectory, "out/init.luau")]: "local x = 1",
			});
			const { childProcess, instrumenter } = setupMocks(volume);
			const stderrText = captureStderr();

			await prepareCoverageAsync(
				makeConfig({
					luauRoots: ["out", ".", "lib"],
					rojoProject: path.join(rootDirectory, "default.project.json"),
					rootDir: rootDirectory,
				}),
				{ childProcess, fileSystem, instrumenter, tsconfigReader: noTsconfig },
			);

			expect(stderrText()).toBe(
				[
					'Warning: luauRoot "." is not a directory inside rootDir, so it reports no coverage.\n',
					'Warning: luauRoot "lib" does not correspond to any rojo $path mount, so it reports no coverage.\n',
				].join(""),
			);
		});

		it("should read, shadow and publish in rootDir when it is not the cwd", async () => {
			expect.assertions(3);

			const rootDirectory = path.resolve("/elsewhere/pkg");
			const { fileSystem, volume } = createMemoryFileSystem({
				[path.join(rootDirectory, "default.project.json")]: JSON.stringify({
					name: "test",
					tree: { $className: "DataModel", ReplicatedStorage: { $path: "out" } },
				}),
				[path.join(rootDirectory, "out/init.luau")]: "local x = 1",
			});
			const { childProcess } = setupMocks(volume);

			const result = await prepareCoverageAsync(
				makeConfig({
					luauRoots: ["out"],
					rojoProject: path.join(rootDirectory, "default.project.json"),
					rootDir: rootDirectory,
				}),
				{ childProcess, fileSystem, tsconfigReader: noTsconfig },
			);

			expect(Object.keys(result.manifest.files)).toStrictEqual([
				`${posixPath(rootDirectory)}/out/init.luau`,
			]);
			expect(
				volume.existsSync(
					path.join(rootDirectory, ".jest-roblox/coverage/coverage-manifest.json"),
				),
			).toBeTrue();
			expect(volume.existsSync(".jest-roblox/coverage/coverage-manifest.json")).toBeFalse();
		});

		it("should auto-detect luauRoots from tsconfig outDir", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = seedFilesystem({ luauRoot: "out" });
			const { childProcess, tsconfigReader } = setupMocks(volume, {
				outDir: "out",
			});
			const config = makeConfig();

			const result = await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				tsconfigReader,
			});

			expect(Object.keys(result.manifest.files)).toStrictEqual(["out/init.luau"]);
		});

		it("should throw when luauRoots contains an absolute path", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = seedFilesystem({ luauRoot: "/abs/out" });
			const { childProcess, instrumenter } = setupMocks(volume);
			const config = makeConfig({ luauRoots: ["/abs/out"] });

			await expect(
				prepareCoverageAsync(config, {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				}),
			).rejects.toThrowWithMessage(
				Error,
				"luauRoots must be relative paths, got absolute path. " +
					"Set a relative outDir in tsconfig or relative luauRoots in config.",
			);
		});

		// `path.isAbsolute` answers for the host it runs on, so a drive-letter
		// root reads as a plain relative filename on Linux: the same config
		// throws on a developer's Windows machine and instruments a root
		// outside the package in CI.
		it("should throw for a drive-letter root on any host", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = seedFilesystem({ luauRoot: "D:/abs/out" });
			const { childProcess, instrumenter } = setupMocks(volume);
			const config = makeConfig({ luauRoots: ["D:/abs/out"] });

			await expect(
				prepareCoverageAsync(config, {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				}),
			).rejects.toThrowWithMessage(
				Error,
				"luauRoots must be relative paths, got absolute path. " +
					"Set a relative outDir in tsconfig or relative luauRoots in config.",
			);
		});

		it("should throw for a file-system root", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = seedFilesystem({ luauRoot: "/" });
			const { childProcess, instrumenter } = setupMocks(volume);
			const config = makeConfig({ luauRoots: ["/"] });

			await expect(
				prepareCoverageAsync(config, {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				}),
			).rejects.toThrowWithMessage(
				Error,
				"luauRoots must be relative paths, got absolute path. " +
					"Set a relative outDir in tsconfig or relative luauRoots in config.",
			);
		});

		it("should throw for an absolute tsconfig outDir", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = seedFilesystem({ luauRoot: "/abs/out" });
			const { childProcess, instrumenter } = setupMocks(volume);
			const config = makeConfig();

			await expect(
				prepareCoverageAsync(config, {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: readingOutDirectory("/abs/out"),
				}),
			).rejects.toThrow(/luauRoots must be relative paths/);
		});

		it("should throw when luauRoots is not provided and tsconfig has no outDir", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = seedFilesystem();
			const { childProcess, instrumenter } = setupMocks(volume);
			const config = makeConfig();

			await expect(
				prepareCoverageAsync(config, {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				}),
			).rejects.toThrow(/Could not determine luauRoots/);
		});
	});

	describe("when preparing the shadow directory", () => {
		it("should wipe and recreate the shadow directory on each run", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = seedFilesystem();
			volume.mkdirSync(".jest-roblox/coverage/stale", { recursive: true });
			volume.writeFileSync(".jest-roblox/coverage/stale/old.txt", "stale");

			const { childProcess, instrumenter } = setupMocks(volume);
			await prepareRootAsync({ childProcess, fileSystem, instrumenter });

			expect(volume.existsSync(".jest-roblox/coverage/stale/old.txt")).toBeFalse();
			expect(volume.existsSync(".jest-roblox/coverage")).toBeTrue();
		});

		it("should write the synthesized project outside the shadow directory", async () => {
			expect.assertions(2);

			const { volume } = await prepareSeededAsync();

			expect(volume.existsSync(".jest-roblox/coverage/default.project.json")).toBeFalse();
			expect(volume.existsSync(".jest-roblox/place/synthesized.project.json")).toBeTrue();
		});

		it("should build the place outside the shadow directory", async () => {
			expect.assertions(1);

			const { volume } = await prepareSeededAsync();

			expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe(
				"rebuilt RBXL",
			);
		});

		it("should mirror every file the instrumenter never emits", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = seedFilesystem();
			// The instrumenter writes the prod `.luau` twins itself. Everything
			// it never emits (spec/test/snap luau and every non-luau rojo file)
			// reaches the shadow through the mirror sync instead.
			volume.writeFileSync("out-tsc/test/init.spec.luau", "-- spec");
			volume.writeFileSync("out-tsc/test/init.meta.json", "{}");
			const { childProcess, instrumenter } = setupMocks(volume);
			await prepareRootAsync({ childProcess, fileSystem, instrumenter });

			expect(
				volume.readFileSync(".jest-roblox/coverage/out-tsc/test/init.spec.luau", "utf-8"),
			).toBe("-- spec");
			expect(
				volume.readFileSync(".jest-roblox/coverage/out-tsc/test/init.meta.json", "utf-8"),
			).toBe("{}");
		});

		it("should mirror an empty source directory on a cold run", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = seedFilesystem();
			// The one class of shadow entry no file write can bring along. rojo
			// mounts an empty directory as a Folder, so a shadow that skips it
			// builds a place missing an Instance the runtime can look up.
			volume.mkdirSync("out-tsc/test/empty", { recursive: true });
			const { childProcess, instrumenter } = setupMocks(volume);
			await prepareRootAsync({ childProcess, fileSystem, instrumenter });

			expect(volume.existsSync(".jest-roblox/coverage/out-tsc/test/empty")).toBeTrue();
		});

		it("should honour the ignore list when luauRoots carries a trailing slash", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = seedFilesystem();
			volume.writeFileSync("out-tsc/test/init.spec.luau", "-- spec");
			volume.writeFileSync("out-tsc/test/init.d.ts", "export {};");
			const { childProcess, instrumenter } = setupMocks(volume);

			// Each walk slices its results against the root it was handed, so a
			// separator left on the end lands the slice a character in and every
			// relative path comes out mangled.
			const config = makeConfig({ luauRoots: ["out-tsc/test/"] });

			await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				instrumenter,
				tsconfigReader: noTsconfig,
			});

			expect(
				volume.existsSync(".jest-roblox/coverage/out-tsc/test/init.spec.luau"),
			).toBeTrue();
			expect(volume.existsSync(".jest-roblox/coverage/out-tsc/test/init.d.ts")).toBeFalse();
		});

		it("should record a trailing-slash root under one canonical spelling", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = seedFilesystem();
			volume.writeFileSync("out-tsc/test/init.spec.luau", "-- spec");
			const { childProcess, instrumenter } = setupMocks(volume);

			const config = makeConfig({ luauRoots: ["out-tsc/test/"] });

			// Every reader downstream of this list tests the root as a prefix:
			// the rojo-inputs hash skips a mount only on `${root}/`, and the
			// next run compares the recorded roots against its own. A separator
			// left on the end matches neither.
			const result = await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				instrumenter,
				tsconfigReader: noTsconfig,
			});

			expect(result.manifest.luauRoots).toStrictEqual(["out-tsc/test"]);
			expect(
				result.manifest.nonInstrumentedFiles["out-tsc/test/init.spec.luau"]!.shadowPath,
			).toBe(".jest-roblox/coverage/out-tsc/test/init.spec.luau");
		});

		it("should leave declaration artifacts out of the shadow directory", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = seedFilesystem();
			// One fixture per default. `.luau.map` earns its own: every reader
			// of a source map opens the one in `outDir`, so the shadow copy is
			// dead weight, but nothing else here would notice it being copied.
			volume.writeFileSync("out-tsc/test/init.d.ts", "export {};");
			volume.writeFileSync("out-tsc/test/init.d.ts.map", "{}");
			volume.writeFileSync("out-tsc/test/init.luau.map", "{}");
			const { childProcess, instrumenter } = setupMocks(volume);
			const result = await prepareRootAsync({ childProcess, fileSystem, instrumenter });

			const ignored = [
				"out-tsc/test/init.d.ts",
				"out-tsc/test/init.d.ts.map",
				"out-tsc/test/init.luau.map",
			];

			expect(
				ignored.filter((relativePath) => {
					return volume.existsSync(`.jest-roblox/coverage/${relativePath}`);
				}),
			).toStrictEqual([]);
			expect(Object.keys(result.manifest.nonInstrumentedFiles)).not.toIncludeAnyMembers(
				ignored,
			);
		});

		it("should keep an ignored directory out of the shadow on a cold run", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = seedFilesystem();
			volume.mkdirSync("out-tsc/test/vendor", { recursive: true });
			volume.writeFileSync("out-tsc/test/vendor/dep.meta.json", "{}");
			const { childProcess, instrumenter } = setupMocks(volume);
			const config = makeConfig({
				coverageCopyIgnorePatterns: ["vendor", "vendor/**"],
				luauRoots: ["out-tsc/test"],
			});

			await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				instrumenter,
				tsconfigReader: noTsconfig,
			});

			expect(volume.existsSync(".jest-roblox/coverage/out-tsc/test/vendor")).toBeFalse();
		});

		it("should mirror declaration artifacts when the ignore list is emptied", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = seedFilesystem();
			volume.writeFileSync("out-tsc/test/init.d.ts", "export {};");
			const { childProcess, instrumenter } = setupMocks(volume);
			const config = makeConfig({
				coverageCopyIgnorePatterns: [],
				luauRoots: ["out-tsc/test"],
			});

			const result = await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				instrumenter,
				tsconfigReader: noTsconfig,
			});

			expect(volume.existsSync(".jest-roblox/coverage/out-tsc/test/init.d.ts")).toBeTrue();
			expect(result.manifest.nonInstrumentedFiles).toHaveProperty("out-tsc/test/init.d.ts");
		});
	});

	describe("when rewriting and building the Rojo project", () => {
		it("should rewrite the Rojo project and invoke rojo build", async () => {
			expect.assertions(2);

			const { volume } = await prepareSeededAsync();

			expect(volume.existsSync(".jest-roblox/place/synthesized.project.json")).toBeTrue();
			expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe(
				"rebuilt RBXL",
			);
		});

		it("should use config.rojoProject when provided", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = seedFilesystem({ rojoProject: "/custom.project.json" });
			const { childProcess, instrumenter } = setupMocks(volume);
			const config = makeConfig({
				luauRoots: ["out-tsc/test"],
				rojoProject: "/custom.project.json",
			});

			await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				instrumenter,
				tsconfigReader: noTsconfig,
			});

			expect(volume.existsSync(".jest-roblox/place/synthesized.project.json")).toBeTrue();
		});

		it("should auto-detect the Rojo project when not configured", async () => {
			expect.assertions(1);

			const { volume } = await prepareSeededAsync();

			expect(volume.existsSync(".jest-roblox/place/synthesized.project.json")).toBeTrue();
		});

		it("should build from a configured non-default project", async () => {
			expect.assertions(1);

			const rojoProject = path.join(PROJECT_DIR, "game.project.json");
			const { fileSystem, volume } = seedFilesystem({ rojoProject });
			const { childProcess, instrumenter } = setupMocks(volume);
			await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"], rojoProject }), {
				childProcess,
				fileSystem,
				instrumenter,
				tsconfigReader: noTsconfig,
			});

			expect(volume.existsSync(".jest-roblox/place/synthesized.project.json")).toBeTrue();
		});

		it("should throw when Rojo project has valid JSON but invalid schema", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = seedFilesystem();
			volume.writeFileSync(
				path.join(PROJECT_DIR, "default.project.json"),
				JSON.stringify({ invalid: true }),
			);
			const { childProcess, instrumenter } = setupMocks(volume);
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			await expect(
				prepareCoverageAsync(config, {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				}),
			).rejects.toThrow(/Invalid Rojo project/);
		});

		it("should throw when no Rojo project is found", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			volume.mkdirSync(PROJECT_DIR, { recursive: true });
			volume.mkdirSync("out-tsc/test", { recursive: true });
			const { childProcess, instrumenter } = setupMocks(volume);
			const config = makeConfig({ luauRoots: ["out-tsc/test"], rojoProject: undefined });

			await expect(
				prepareCoverageAsync(config, {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				}),
			).rejects.toThrow(/No Rojo project found/);
		});
	});

	describe("when building the coverage place for the run-mode runner", () => {
		it("should enable LoadString so the studio-cli Run-mode runner's gate passes", async () => {
			expect.assertions(1);

			const { volume } = await prepareSeededAsync();

			const written = readRojoProjectJson(
				volume,
				".jest-roblox/place/synthesized.project.json",
			);

			expect(
				readNestedProperty(
					written,
					"tree",
					"ServerScriptService",
					"$properties",
					"LoadStringEnabled",
				),
			).toBeTrue();
		});
	});

	describe("when computing $path entries for the rewritten project", () => {
		it("should express $path entries relative to the rewritten project's own directory", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();

			const projectWithExternal = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$path: "out-tsc/test/client",
					},
					ServerScriptService: {
						$path: "include",
					},
				},
			};

			volume.mkdirSync(".", { recursive: true });
			volume.mkdirSync("out-tsc/test", { recursive: true });
			volume.writeFileSync("out-tsc/test/init.luau", "local x = 1");
			volume.writeFileSync("default.project.json", JSON.stringify(projectWithExternal));

			const { childProcess, instrumenter } = setupMocks(volume);
			const config = makeConfig({ luauRoots: ["out-tsc/test"], rootDir: "." });

			await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				instrumenter,
				tsconfigReader: noTsconfig,
			});

			const written = readRojoProjectJson(
				volume,
				".jest-roblox/place/synthesized.project.json",
			);

			// Paths are written relative to the project file's own directory:
			// rojo matches globIgnorePaths against the path as expressed, so an
			// absolute one would leave every ignore pattern inert.
			//
			// Matching path: the shadow dir, one directory over from the
			// project file.
			expect(readNestedProperty(written, "tree", "ReplicatedStorage", "$path")).toBe(
				"../coverage/out-tsc/test/client",
			);
			// Non-matching path: the original source dir, two levels up.
			expect(readNestedProperty(written, "tree", "ServerScriptService", "$path")).toBe(
				"../../include",
			);
		});
	});

	describe("when rojoProject lives outside rootDir", () => {
		it("should redirect luauRoot against rootDir, not the rojo project's directory", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			// Project file in a `config/` subdirectory mounts `../out` (the
			// real source root). rootDir stays at the package root, luauRoot
			// is the rootDir-relative "out".
			const project = {
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { $path: "../out" },
				},
			};

			volume.mkdirSync("config", { recursive: true });
			volume.mkdirSync("out", { recursive: true });
			volume.writeFileSync("out/init.luau", "local x = 1");
			volume.writeFileSync("config/dev.project.json", JSON.stringify(project));

			const { childProcess, instrumenter } = setupMocks(volume);
			const config = makeConfig({
				luauRoots: ["out"],
				rojoProject: "config/dev.project.json",
				rootDir: ".",
			});

			await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				instrumenter,
				tsconfigReader: noTsconfig,
			});

			const parsed = readRojoProjectJson(
				volume,
				".jest-roblox/place/synthesized.project.json",
			);

			// $path "../out" resolves against "config" → absolute "out";
			// luauRoot "out" resolves against rootDir "." → absolute "out";
			// match → redirect to the shadow dir, written relative to the
			// project file one directory over from it.
			expect(readNestedProperty(parsed, "tree", "ReplicatedStorage", "$path")).toBe(
				"../coverage/out",
			);
		});
	});

	describe("when Rojo project has nested project references", () => {
		it("should resolve nested .project.json refs before rewriting paths", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			const developmentProject = {
				name: "development",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						"uuid-generator": {
							$path: "default.project.json",
						},
					},
				},
			};
			const defaultProject = {
				name: "uuid-generator",
				tree: {
					$className: "Folder",
					$path: "src",
				},
			};

			volume.mkdirSync(PROJECT_DIR, { recursive: true });
			volume.mkdirSync("src", { recursive: true });
			volume.writeFileSync("src/init.luau", "local x = 1");
			volume.writeFileSync(
				path.join(PROJECT_DIR, "development.project.json"),
				JSON.stringify(developmentProject),
			);
			volume.writeFileSync(
				path.join(PROJECT_DIR, "default.project.json"),
				JSON.stringify(defaultProject),
			);

			const { childProcess, instrumenter } = setupMocks(volume);
			const config = makeConfig({
				luauRoots: ["src"],
				rojoProject: path.join(PROJECT_DIR, "development.project.json"),
			});

			await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				instrumenter,
				tsconfigReader: noTsconfig,
			});

			const written = readRojoProjectJson(
				volume,
				".jest-roblox/place/synthesized.project.json",
			);

			// The nested $path: "default.project.json" is resolved to $path:
			// "src", then redirected to the instrumented shadow dir since "src"
			// matches the configured luauRoot, and written relative to the
			// project file, which sits one directory over from that shadow dir.
			expect(
				readNestedProperty(written, "tree", "ReplicatedStorage", "uuid-generator", "$path"),
			).toBe("../coverage/src");
		});
	});

	describe("when returning results", () => {
		it("should return the manifest and placeFile path", async () => {
			expect.assertions(2);

			const { result } = await prepareSeededAsync();

			expect(result.manifest.luauRoots).toStrictEqual(["out-tsc/test"]);
			expect(result.placeFile).toContain("game.rbxl");
		});
	});

	describe("when resolving the build artifacts", () => {
		it("should return the coverage place, buildId, and rebuilt flag", async () => {
			expect.assertions(3);

			const { result } = await prepareSeededAsync();

			expect(result.buildId).toMatch(/^[0-9a-f-]{36}$/);
			expect(result.coveragePlace.hash).toMatch(/^[a-f0-9]{64}$/);
			expect(result.rebuilt).toBeTrue();
		});

		it("should omit an unavailable input digest from a rebuilt manifest", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = seedFilesystem();
			const { childProcess, instrumenter } = setupMocks(volume);
			vi.spyOn(fileSystem.promises, "readFile").mockRejectedValueOnce(
				new Error("temporary read failure"),
			);
			const result = await prepareRootAsync({ childProcess, fileSystem, instrumenter });

			expect(result.rebuilt).toBeTrue();
			expect(
				readCoverageManifestFile(volume, ".jest-roblox/coverage/coverage-manifest.json"),
			).not.toHaveProperty("rojoInputsHash");
		});

		it("should report the place build apart from the instrumentation", async () => {
			expect.assertions(3);

			const { fileSystem, volume } = seedFilesystem();
			const { childProcess, execFile, instrumenter } = setupMocks(volume);
			const clock = movableClockCollector(1_000);
			const profile = vi.spyOn(clock.timing, "profileTimedAsync");

			execFile.mockImplementation(
				writingRojoExec({
					bytes: "RBXL",
					fileSystem: volume,
					onBuild: () => {
						clock.advance(250);
					},
				}),
			);
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			const result = await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				instrumenter,
				timing: clock.timing,
				tsconfigReader: noTsconfig,
			});

			expect(result.stagingMs).toBe(250);
			expect(result.instrumentMs).toBe(0);
			expect(profile.mock.calls.map(([name]) => name)).toIncludeAllMembers([
				"instrumentSources",
				"bakeCoveragePlace",
			]);
		});

		it("should share the buildId with the coverage manifest it wrote", async () => {
			expect.assertions(1);

			const { result, volume } = await prepareSeededAsync();

			const coverage = readCoverageManifestFile(
				volume,
				".jest-roblox/coverage/coverage-manifest.json",
			);

			expect(result.buildId).toBe(coverage.buildId);
		});

		it("should record source hashes for the build manifest in the result", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = seedFilesystem();
			const { childProcess, instrumenter } = setupMocks(volume);
			instrumenter.mockImplementation((options) => {
				return {
					[`${options.luauRoot}/init.luau`]: {
						key: `${options.luauRoot}/init.luau`,
						branchCount: 0,
						coverageMapPath: `${options.luauRoot}/init.cov-map.json`,
						functionCount: 0,
						instrumentedLuauPath: `.jest-roblox/coverage/${options.luauRoot}/init.luau`,
						originalLuauPath: `${options.luauRoot}/init.luau`,
						sourceHash: "deadbeef",
						sourceMapPath: `${options.luauRoot}/init.luau.map`,
						statementCount: 0,
					},
				};
			});
			const result = await prepareRootAsync({ childProcess, fileSystem, instrumenter });

			expect(result.files["out-tsc/test/init.luau"]!.sourceHash).toBe("deadbeef");
		});

		it("should not write a build manifest (the entry point owns emission)", async () => {
			expect.assertions(1);

			const { volume } = await prepareSeededAsync();

			expect(volume.existsSync(".jest-roblox/coverage/build-manifest.json")).toBeFalse();
		});

		it("should leave no coverage manifest when rojo build fails", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = seedFilesystem();
			const { childProcess, execFile, instrumenter } = setupMocks(volume);

			execFile.mockImplementation((...callArgs) => {
				callArgs[3](new Error("spawn failed"), "", "");
			});
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });

			await expect(
				prepareCoverageAsync(config, {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				}),
			).rejects.toThrow(/rojo build failed/);
			expect(volume.existsSync(".jest-roblox/coverage/coverage-manifest.json")).toBeFalse();
		});
	});

	describe("when narrowing to the coverage universe", () => {
		async function seedTwoFilesAsync() {
			const { fileSystem, volume } = seedFilesystem();
			volume.mkdirSync("out-tsc/test/ui", { recursive: true });
			volume.writeFileSync(UNCOVERED_FILE, "local y = 2");
			return { ...setupMocks(volume), fileSystem, volume };
		}

		function narrowedConfig(): ResolvedConfig {
			return makeConfig({
				collectCoverageFrom: [COVERED_FILE],
				luauRoots: ["out-tsc/test"],
			});
		}

		it("should hold an out-of-universe file back from the instrumenter", async () => {
			expect.assertions(1);

			const { childProcess, fileSystem } = await seedTwoFilesAsync();

			const result = await prepareCoverageAsync(narrowedConfig(), {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			expect(Object.keys(result.manifest.files)).toStrictEqual([COVERED_FILE]);
		});

		it("should mirror an out-of-universe file into the shadow instead", async () => {
			expect.assertions(2);

			const { childProcess, fileSystem, volume } = await seedTwoFilesAsync();

			const result = await prepareCoverageAsync(narrowedConfig(), {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			// Still in the place, just without probes. The runtime has to be
			// able to require it, the report just never asks about it.
			expect(result.manifest.nonInstrumentedFiles).toHaveProperty(UNCOVERED_FILE);
			expect(volume.existsSync(`.jest-roblox/coverage/${UNCOVERED_FILE}`)).toBeTrue();
		});

		/**
		 * Two mounted roots where the universe reaches only the first. Written
		 * from `rootDir: "."` so the rewritten project's `$path` entries are
		 * comparable: a redirected mount is a sibling of the project file, an
		 * untouched one is two levels up.
		 * @returns The seeded file system, volume and mocks.
		 */
		async function seedTwoRootsAsync() {
			const { fileSystem, volume } = createMemoryFileSystem();

			volume.mkdirSync("out-tsc/test", { recursive: true });
			volume.writeFileSync(COVERED_FILE, "local x = 1");
			volume.mkdirSync("out-tsc/vendor", { recursive: true });
			volume.writeFileSync("out-tsc/vendor/dep.luau", "local d = 1");
			volume.writeFileSync(
				"default.project.json",
				JSON.stringify({
					name: "test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { $path: "out-tsc/test" },
						ServerScriptService: { $path: "out-tsc/vendor" },
					},
				}),
			);

			return { ...setupMocks(volume), fileSystem, volume };
		}

		function twoRootConfig(): ResolvedConfig {
			return makeConfig({
				collectCoverageFrom: [COVERED_FILE],
				luauRoots: ["out-tsc/test", "out-tsc/vendor"],
				rootDir: ".",
			});
		}

		it("should leave a root the universe never touches out of the shadow", async () => {
			expect.assertions(2);

			const { childProcess, fileSystem, volume } = await seedTwoRootsAsync();

			const result = await prepareCoverageAsync(twoRootConfig(), {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			expect(result.manifest.luauRoots).toStrictEqual(["out-tsc/test"]);
			expect(volume.existsSync(".jest-roblox/coverage/out-tsc/vendor")).toBeFalse();
		});

		it("should keep a root with no shadow mounted on the source it already served", async () => {
			expect.assertions(2);

			const { childProcess, fileSystem, volume } = await seedTwoRootsAsync();

			await prepareCoverageAsync(twoRootConfig(), {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			const written = readRojoProjectJson(
				volume,
				".jest-roblox/place/synthesized.project.json",
			);

			// The redirected root is one directory over from the rewritten
			// project file.
			expect(readNestedProperty(written, "tree", "ReplicatedStorage", "$path")).toBe(
				"../coverage/out-tsc/test",
			);
			// The untouched one still points at the original tree, which serves
			// exactly the bytes its shadow would have.
			expect(readNestedProperty(written, "tree", "ServerScriptService", "$path")).toBe(
				"../../out-tsc/vendor",
			);
		});

		it("should reuse the place when nothing under either root changed", async () => {
			expect.assertions(1);

			const { childProcess, fileSystem } = await seedTwoRootsAsync();

			await prepareCoverageAsync(twoRootConfig(), {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			// The control for the test below: a second run over an untouched
			// tree must reuse, or "rebuilt" proves nothing there.
			const second = await prepareCoverageAsync(twoRootConfig(), {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			expect(second.rebuilt).toBeFalse();
		});

		it("should rebuild when a file changes in a root the universe never touches", async () => {
			expect.assertions(1);

			const { childProcess, fileSystem, volume } = await seedTwoRootsAsync();

			await prepareCoverageAsync(twoRootConfig(), {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});
			// The place mounts this root's source directly, so its bytes are in
			// the built place, but no shadow record covers them, and the rojo
			// inputs hash skips whatever the shadow is supposed to be watching.
			// Something has to notice, or the run serves a stale place.
			volume.writeFileSync("out-tsc/vendor/dep.luau", "local d = 2");

			const second = await prepareCoverageAsync(twoRootConfig(), {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			expect(second.rebuilt).toBeTrue();
		});

		it("should keep the shadow when the ignore list is what emptied the root", async () => {
			expect.assertions(2);

			const { childProcess, fileSystem, volume } = await seedTwoFilesAsync();

			// The universe reaches `init.luau` and the ignore list takes it, so
			// the root ends up with nothing to probe for a reason the mount
			// cannot serve: dropping the shadow here would mount the source and
			// put the excluded module straight back into the place.
			const result = await prepareCoverageAsync(
				makeConfig({
					collectCoverageFrom: [COVERED_FILE],
					coverageCopyIgnorePatterns: ["init.luau"],
					luauRoots: ["out-tsc/test"],
				}),
				{ childProcess, fileSystem, tsconfigReader: noTsconfig },
			);

			expect(volume.existsSync(`.jest-roblox/coverage/${COVERED_FILE}`)).toBeFalse();
			expect(result.manifest.nonInstrumentedFiles).toHaveProperty(UNCOVERED_FILE);
		});

		it("should instrument the whole root with explicitly unrestricted coverage", async () => {
			expect.assertions(2);

			const { childProcess, fileSystem } = await seedTwoFilesAsync();

			const result = await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			// Nothing to hold back, and nothing carried forward on a cold run.
			expect(Object.keys(result.manifest.files).sort()).toStrictEqual(
				[COVERED_FILE, UNCOVERED_FILE].sort(),
			);
			expect(result.manifest.coverageUniverseHash).toBeUndefined();
		});

		it("should instrument by the caller's universe in place of the coverage globs", async () => {
			expect.assertions(2);

			const { childProcess, fileSystem } = await seedTwoFilesAsync();

			const result = await prepareCoverageAsync(narrowedConfig(), {
				childProcess,
				fileSystem,
				instrumentUniverse: {
					digest: "caller-universe",
					includes: (luauPath) => path.resolve(luauPath) === path.resolve(UNCOVERED_FILE),
				},
				tsconfigReader: noTsconfig,
			});

			expect(Object.keys(result.manifest.files)).toStrictEqual([UNCOVERED_FILE]);
			expect(result.manifest.coverageUniverseHash).toBe("caller-universe");
		});

		it("should record the universe digest in the manifest", async () => {
			expect.assertions(1);

			const { childProcess, fileSystem } = await seedTwoFilesAsync();

			const result = await prepareCoverageAsync(narrowedConfig(), {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			expect(result.manifest.coverageUniverseHash).toMatch(/^[a-f0-9]{64}$/);
		});

		it("should rebuild cold when the coverage globs changed since the last run", async () => {
			expect.assertions(1);

			const { childProcess, fileSystem, volume } = await seedTwoFilesAsync();
			volume.mkdirSync(".jest-roblox/coverage", { recursive: true });
			volume.writeFileSync(
				".jest-roblox/coverage/coverage-manifest.json",
				JSON.stringify({
					buildId: "prev-build-id",
					coverageUniverseHash: "a-different-universe",
					files: {},
					generatedAt: isoNow(),
					instrumenterVersion: INSTRUMENTER_VERSION,
					luauRoots: ["out-tsc/test"],
					nonInstrumentedFiles: {},
					shadowDir: ".jest-roblox/coverage",
					version: MANIFEST_VERSION,
				}),
			);

			const result = await prepareCoverageAsync(narrowedConfig(), {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			// The previous shadow was wiped, so the skip list carries no
			// previously-instrumented file forward, only the exclusions.
			expect(Object.keys(result.manifest.files)).toStrictEqual([COVERED_FILE]);
		});
	});

	describe("when running in incremental mode", () => {
		function sha256(content: string): string {
			return crypto.createHash("sha256").update(content).digest("hex");
		}

		function makeFileRecord(
			overrides: Partial<InstrumentedFileRecord> & { key: string },
		): InstrumentedFileRecord {
			return {
				branchCount: 0,
				coverageMapPath: overrides.key.replace(/\.luau$/, ".cov-map.json"),
				functionCount: 0,
				instrumentedLuauPath: `.jest-roblox/coverage/${overrides.key}`,
				originalLuauPath: overrides.key,
				sourceHash: sha256("local x = 1"),
				sourceMapPath: `${overrides.key}.map`,
				statementCount: 0,
				...overrides,
			};
		}

		function seedPreviousManifest(
			volume: MemoryVolume,
			manifest: Except<CoverageManifest, "buildId"> & { buildId?: string },
		) {
			volume.mkdirSync(".jest-roblox/coverage", { recursive: true });
			volume.writeFileSync(
				".jest-roblox/coverage/coverage-manifest.json",
				// The digest of the config these scenarios run under. Without it
				// every incremental case would gate itself onto the cold path.
				JSON.stringify({
					buildId: "prev-build-id",
					copyIgnoreHash: DEFAULT_COPY_IGNORE_HASH,
					...manifest,
				}),
			);
		}

		async function seedIncrementalScenarioAsync(
			fileSystem: FileSystem,
			{
				copyIgnoreHash = DEFAULT_COPY_IGNORE_HASH,
				fileContents = { "out-tsc/test/init.luau": "local x = 1" },
				previousFiles = {
					"out-tsc/test/init.luau": makeFileRecord({
						key: "out-tsc/test/init.luau",
					}),
				},
				previousInstrumenterVersion = INSTRUMENTER_VERSION,
				previousNonInstrumentedFiles = {},
				previousPlaceFilePath = ".jest-roblox/place/game.rbxl",
				volume,
			}: {
				copyIgnoreHash?: string;
				fileContents?: Record<string, string>;
				previousFiles?: Record<string, InstrumentedFileRecord>;
				previousInstrumenterVersion?: number;
				previousNonInstrumentedFiles?: Record<string, NonInstrumentedFileRecord>;
				previousPlaceFilePath?: string;
				volume: MemoryVolume;
			},
		) {
			seedInto(volume);

			// Seed source files with specified content
			for (const [filePath, content] of Object.entries(fileContents)) {
				const directory = filePath.substring(0, filePath.lastIndexOf("/"));
				volume.mkdirSync(directory, { recursive: true });
				volume.writeFileSync(filePath, content);
			}

			// Seed shadow dir with "instrumented" files
			for (const record of Object.values(previousFiles)) {
				const shadowPath = record.instrumentedLuauPath;
				const directory = shadowPath.substring(0, shadowPath.lastIndexOf("/"));
				volume.mkdirSync(directory, { recursive: true });
				volume.writeFileSync(shadowPath, "-- instrumented");
				// Also seed cov-map sidecar
				volume.writeFileSync(record.coverageMapPath, "{}");
			}

			// Seed shadow dir with non-instrumented files
			for (const record of Object.values(previousNonInstrumentedFiles)) {
				const directory = record.shadowPath.substring(
					0,
					record.shadowPath.lastIndexOf("/"),
				);
				volume.mkdirSync(directory, { recursive: true });
				volume.writeFileSync(record.shadowPath, "-- old spec content");
			}

			// Seed previous place file
			if (previousPlaceFilePath) {
				volume.mkdirSync(path.dirname(previousPlaceFilePath), { recursive: true });
				volume.writeFileSync(previousPlaceFilePath, "RBXL");
			}

			seedPreviousManifest(volume, {
				copyIgnoreHash,
				files: previousFiles,
				generatedAt: isoNow(),
				instrumenterVersion: previousInstrumenterVersion,
				luauRoots: ["out-tsc/test"],
				nonInstrumentedFiles: previousNonInstrumentedFiles,
				placeFilePath: previousPlaceFilePath,
				rojoInputsHash: rojoInputsHash(fileSystem, {
					rojoProjectPath: path.join(PROJECT_DIR, "default.project.json"),
					rootDirectory: PROJECT_DIR,
				}),
				shadowDir: ".jest-roblox/coverage",
				version: MANIFEST_VERSION,
			});
		}

		function setupMemoryMocks() {
			const memory = createMemoryFileSystem();
			return { ...memory, ...setupMocks(memory.volume) };
		}

		async function seedCachedSpecAsync({
			fileSystem,
			specContent,
			volume,
		}: {
			fileSystem: FileSystem;
			specContent: string;
			volume: MemoryVolume;
		}): Promise<NonInstrumentedFileRecord> {
			const specRecord: NonInstrumentedFileRecord = {
				shadowPath: ".jest-roblox/coverage/out-tsc/test/init.spec.luau",
				sourceHash: sha256(specContent),
				sourcePath: "out-tsc/test/init.spec.luau",
			};
			await seedIncrementalScenarioAsync(fileSystem, {
				fileContents: {
					"out-tsc/test/init.luau": "local x = 1",
					"out-tsc/test/init.spec.luau": specContent,
				},
				previousNonInstrumentedFiles: { "out-tsc/test/init.spec.luau": specRecord },
				volume,
			});
			return specRecord;
		}

		async function seedDeletedFileScenarioAsync({
			fileSystem,
			volume,
		}: {
			fileSystem: FileSystem;
			volume: MemoryVolume;
		}): Promise<void> {
			await seedIncrementalScenarioAsync(fileSystem, {
				fileContents: {
					"out-tsc/test/deleted.luau": "local y = 1",
					"out-tsc/test/init.luau": "local x = 1",
				},
				previousFiles: {
					"out-tsc/test/deleted.luau": makeFileRecord({
						key: "out-tsc/test/deleted.luau",
						coverageMapPath: ".jest-roblox/coverage/out-tsc/test/deleted.cov-map.json",
						instrumentedLuauPath: ".jest-roblox/coverage/out-tsc/test/deleted.luau",
					}),
					"out-tsc/test/init.luau": makeFileRecord({ key: "out-tsc/test/init.luau" }),
				},
				volume,
			});
		}

		function writeValidBuildManifest(volume: MemoryVolume): void {
			volume.writeFileSync(
				".jest-roblox/coverage/build-manifest.json",
				JSON.stringify({
					buildId: "prev-build-id",
					coveragePlace: { hash: sha256("RBXL"), path: ".jest-roblox/place/game.rbxl" },
					files: {},
					generatedAt: isoNow(),
					projects: [],
					version: BUILD_MANIFEST_VERSION,
				}),
			);
		}

		function packageRecord({
			name,
			source,
		}: {
			name: string;
			source: string;
		}): InstrumentedFileRecord {
			return makeFileRecord({
				key: `packages/${name}/out/init.luau`,
				coverageMapPath: `.jest-roblox/coverage/packages/${name}/out/init.cov-map.json`,
				instrumentedLuauPath: `.jest-roblox/coverage/packages/${name}/out/init.luau`,
				sourceHash: sha256(source),
			});
		}

		function writeShadowFiles(
			volume: MemoryVolume,
			records: Array<InstrumentedFileRecord>,
		): void {
			for (const record of records) {
				volume.mkdirSync(path.posix.dirname(record.instrumentedLuauPath), {
					recursive: true,
				});
				volume.writeFileSync(record.instrumentedLuauPath, "-- instrumented");
				volume.writeFileSync(record.coverageMapPath, "{}");
			}
		}

		it("should store sourceHash in each file record", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = seedFilesystem();
			const { childProcess, instrumenter } = setupMocks(volume);
			instrumenter.mockImplementation((options) => {
				return {
					[`${options.luauRoot}/init.luau`]: makeFileRecord({
						key: `${options.luauRoot}/init.luau`,
					}),
				};
			});
			const result = await prepareRootAsync({ childProcess, fileSystem, instrumenter });

			const record = Object.values(result.manifest.files)[0];

			expect(record!.sourceHash).toMatch(/^[a-f0-9]{64}$/);
		});

		it("should include instrumenterVersion in manifest", async () => {
			expect.assertions(1);

			const { result } = await prepareSeededAsync();

			expect(result.manifest.instrumenterVersion).toBe(INSTRUMENTER_VERSION);
		});

		it("should include placeFilePath in manifest", async () => {
			expect.assertions(1);

			const { result } = await prepareSeededAsync();

			expect(result.manifest.placeFilePath).toContain("game.rbxl");
		});

		it("should carry forward records for unchanged files without calling instrumentRoot", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();

			const { childProcess } = setupMocks(volume);

			await seedIncrementalScenarioAsync(fileSystem, { volume });
			await prepareRootAsync({ childProcess, fileSystem });

			const result = await prepareRootAsync({ childProcess, fileSystem });

			expect(
				volume.readFileSync(".jest-roblox/coverage/out-tsc/test/init.luau", "utf8"),
			).toBe("-- instrumented");
			expect(result.manifest.files["out-tsc/test/init.luau"]).toBeDefined();
		});

		it("should re-instrument files whose source hash changed", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			const { childProcess } = setupMocks(volume);

			await seedIncrementalScenarioAsync(fileSystem, {
				fileContents: { "out-tsc/test/init.luau": "local x = 2" },
				volume,
			});

			const result = await prepareRootAsync({ childProcess, fileSystem });

			expect(result.manifest.files["out-tsc/test/init.luau"]!.sourceHash).toBe(
				sha256("local x = 2"),
			);
		});

		it("should instrument new files not in previous manifest", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();

			const { childProcess } = setupMocks(volume);

			await seedIncrementalScenarioAsync(fileSystem, { volume });
			// Add a new source file
			volume.writeFileSync("out-tsc/test/new.luau", "local y = 1");

			const result = await prepareRootAsync({ childProcess, fileSystem });

			expect(result.manifest.files["out-tsc/test/new.luau"]!.sourceHash).toBe(
				sha256("local y = 1"),
			);
			expect(
				volume.readFileSync(
					result.manifest.files["out-tsc/test/init.luau"]!.instrumentedLuauPath,
					"utf8",
				),
			).toBe("-- instrumented");
		});

		it("should remove deleted files from shadow dir and manifest", async () => {
			expect.assertions(2);

			const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

			await seedDeletedFileScenarioAsync({ fileSystem, volume });
			// Remove the source file (simulating deletion after previous run)
			volume.unlinkSync("out-tsc/test/deleted.luau");

			const result = await prepareRootAsync({ childProcess, fileSystem, instrumenter });

			expect(result.manifest.files["out-tsc/test/deleted.luau"]).toBeUndefined();
			expect(
				volume.existsSync(".jest-roblox/coverage/out-tsc/test/deleted.luau"),
			).toBeFalse();
		});

		it("should handle cleanup when shadow files are already missing", async () => {
			expect.assertions(1);

			const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

			await seedDeletedFileScenarioAsync({ fileSystem, volume });
			// Remove source AND shadow files (simulating prior partial cleanup)
			volume.unlinkSync("out-tsc/test/deleted.luau");
			volume.unlinkSync(".jest-roblox/coverage/out-tsc/test/deleted.luau");
			volume.unlinkSync(".jest-roblox/coverage/out-tsc/test/deleted.cov-map.json");

			const result = await prepareRootAsync({ childProcess, fileSystem, instrumenter });

			expect(result.manifest.files["out-tsc/test/deleted.luau"]).toBeUndefined();
		});

		it("should rebuild when raw Rojo input changes normalize to the same synthesized tree", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = seedFilesystem();
			const { childProcess } = setupMocks(volume);
			const first = await prepareRootAsync({ childProcess, fileSystem });
			const projectFile = path.join(PROJECT_DIR, "default.project.json");
			volume.writeFileSync(
				projectFile,
				`${String(volume.readFileSync(projectFile, "utf8"))}\n`,
			);
			const second = await prepareRootAsync({ childProcess, fileSystem });

			expect(second.rebuilt).toBeTrue();
			expect(second.buildId).not.toBe(first.buildId);
		});

		it("should reuse when the original input digest is temporarily unavailable", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = seedFilesystem();
			const { childProcess } = setupMocks(volume);
			const first = await prepareRootAsync({ childProcess, fileSystem });
			vi.spyOn(fileSystem.promises, "readFile").mockRejectedValueOnce(
				new Error("temporary read failure"),
			);
			const second = await prepareRootAsync({ childProcess, fileSystem });

			expect(second.rebuilt).toBeFalse();
			expect(second.buildId).toBe(first.buildId);
		});

		it("should keep the build identity and timestamp on a no-change rerun", async () => {
			expect.assertions(4);

			const { fileSystem, volume } = seedFilesystem();
			const { childProcess } = setupMocks(volume);
			const first = await prepareRootAsync({ childProcess, fileSystem });
			const second = await prepareRootAsync({ childProcess, fileSystem });

			expect(first.rebuilt).toBeTrue();
			expect(second.rebuilt).toBeFalse();
			expect(second.buildId).toBe(first.buildId);
			expect(second.manifest.generatedAt).toBe(first.manifest.generatedAt);
		});

		it("should rebuild when no files changed but the prior place is missing on disk", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			const { childProcess, instrumenter } = setupMocks(volume);

			await seedIncrementalScenarioAsync(fileSystem, { volume });
			volume.unlinkSync(".jest-roblox/place/game.rbxl");

			await prepareRootAsync({ childProcess, fileSystem, instrumenter });

			expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe(
				"rebuilt RBXL",
			);
		});

		it("should rebuild when the prior place sits outside the place directory", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			const { childProcess, instrumenter } = setupMocks(volume);

			await seedIncrementalScenarioAsync(fileSystem, {
				previousPlaceFilePath: ".jest-roblox/coverage/game.rbxl",
				volume,
			});

			await prepareRootAsync({ childProcess, fileSystem, instrumenter });

			expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe(
				"rebuilt RBXL",
			);
		});

		it("should rebuild when the cached place bytes drift", async () => {
			expect.assertions(3);

			const { fileSystem, volume } = seedFilesystem();
			const { childProcess } = setupMocks(volume);
			const first = await prepareRootAsync({ childProcess, fileSystem });
			volume.writeFileSync(first.placeFile, "tampered place");
			const second = await prepareRootAsync({ childProcess, fileSystem });

			expect(second.rebuilt).toBeTrue();
			expect(second.buildId).not.toBe(first.buildId);
			expect(volume.readFileSync(second.placeFile, "utf8")).toBe("rebuilt RBXL");
		});

		it("should reuse the prior place when the build manifest validates", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			const { childProcess, instrumenter } = setupMocks(volume);

			await seedIncrementalScenarioAsync(fileSystem, { volume });
			writeValidBuildManifest(volume);
			await prepareRootAsync({ childProcess, fileSystem });

			await prepareRootAsync({ childProcess, fileSystem, instrumenter });

			expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe(
				"rebuilt RBXL",
			);
		});

		it("should report the reuse gate as staging when nothing is rebuilt", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();

			const { childProcess, instrumenter } = setupMocks(volume);

			await seedIncrementalScenarioAsync(fileSystem, { volume });
			writeValidBuildManifest(volume);
			await prepareRootAsync({ childProcess, fileSystem });

			const config = makeConfig({ luauRoots: ["out-tsc/test"] });
			const result = await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				instrumenter,
				timing: tickingClockCollector(1_000, 5),
				tsconfigReader: noTsconfig,
			});

			expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe(
				"rebuilt RBXL",
			);
			expect(result.stagingMs).toBeGreaterThan(0);
		});

		it("should instrument a new file while preserving the cached twin", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();

			const { childProcess } = setupMocks(volume);

			await seedIncrementalScenarioAsync(fileSystem, { volume });
			volume.writeFileSync("out-tsc/test/new-module.luau", "local y = 2");

			const result = await prepareRootAsync({ childProcess, fileSystem });

			expect(
				volume.readFileSync(
					result.manifest.files["out-tsc/test/new-module.luau"]!.instrumentedLuauPath,
					"utf8",
				),
			).toContain("local y = 2");
			expect(
				volume.readFileSync(".jest-roblox/coverage/out-tsc/test/init.luau", "utf8"),
			).toBe("-- instrumented");
		});

		it("should discard a deleted file while preserving the cached twin", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();

			const { childProcess } = setupMocks(volume);

			await seedIncrementalScenarioAsync(fileSystem, {
				fileContents: {
					"out-tsc/test/a.luau": "local a = 1",
					"out-tsc/test/b.luau": "local b = 1",
				},
				previousFiles: {
					"out-tsc/test/a.luau": makeFileRecord({
						key: "out-tsc/test/a.luau",
						sourceHash: sha256("local a = 1"),
					}),
					"out-tsc/test/b.luau": makeFileRecord({
						key: "out-tsc/test/b.luau",
						sourceHash: sha256("local b = 1"),
					}),
				},
				volume,
			});
			volume.unlinkSync("out-tsc/test/b.luau");

			const result = await prepareRootAsync({ childProcess, fileSystem });

			expect(
				volume.readFileSync(
					result.manifest.files["out-tsc/test/a.luau"]!.instrumentedLuauPath,
					"utf8",
				),
			).toContain("-- instrumented");
			expect(result.manifest.files).not.toHaveProperty("out-tsc/test/b.luau");
		});

		it("should still rebuild rojo when only non-instrumented file changed", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();

			const { childProcess } = setupMocks(volume);

			const specRecord: NonInstrumentedFileRecord = {
				shadowPath: ".jest-roblox/coverage/out-tsc/test/init.spec.luau",
				sourceHash: sha256("-- old spec"),
				sourcePath: "out-tsc/test/init.spec.luau",
			};

			await seedIncrementalScenarioAsync(fileSystem, {
				previousNonInstrumentedFiles: { "out-tsc/test/init.spec.luau": specRecord },
				volume,
			});
			volume.writeFileSync("out-tsc/test/init.spec.luau", "-- new spec");

			await prepareRootAsync({ childProcess, fileSystem });

			expect(
				volume.readFileSync(".jest-roblox/coverage/out-tsc/test/init.luau", "utf8"),
			).toBe("-- instrumented");
			expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe(
				"rebuilt RBXL",
			);
		});

		it("should wipe and re-instrument all when cache is disabled", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			const { childProcess } = setupMocks(volume);

			await seedIncrementalScenarioAsync(fileSystem, { volume });

			const config = makeConfig({
				coverageCache: false,
				luauRoots: ["out-tsc/test"],
			});

			const result = await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			expect(
				volume.readFileSync(
					result.manifest.files[COVERED_FILE]!.instrumentedLuauPath,
					"utf8",
				),
			).toContain("local x = 1");
		});

		it("should wipe shadow directory when cache is disabled", async () => {
			expect.assertions(2);

			const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

			await seedIncrementalScenarioAsync(fileSystem, { volume });
			volume.writeFileSync(".jest-roblox/coverage/stale.txt", "stale");

			const config = makeConfig({
				coverageCache: false,
				luauRoots: ["out-tsc/test"],
			});

			await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				instrumenter,
				tsconfigReader: noTsconfig,
			});

			expect(volume.existsSync(".jest-roblox/coverage/stale.txt")).toBeFalse();
			expect(volume.existsSync(".jest-roblox/coverage")).toBeTrue();
		});

		it("should handle luauRoots change between runs", async () => {
			expect.assertions(1);

			const { childProcess, fileSystem, volume } = setupMemoryMocks();
			await seedIncrementalScenarioAsync(fileSystem, { volume });
			volume.mkdirSync("packages/core/out", { recursive: true });
			volume.writeFileSync("packages/core/out/init.luau", "local z = 1");
			volume.writeFileSync(
				path.join(PROJECT_DIR, "default.project.json"),
				JSON.stringify({
					name: "test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: {
							core: { $path: "packages/core/out" },
							test: { $path: "out-tsc/test/client" },
						},
					},
				}),
			);
			const config = makeConfig({
				luauRoots: ["out-tsc/test", "packages/core/out"],
			});

			const result = await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			expect(
				volume.readFileSync(
					result.manifest.files["packages/core/out/init.luau"]!.instrumentedLuauPath,
					"utf8",
				),
			).toContain("local z = 1");
		});

		it("should fall back to full instrumentation when manifest JSON is malformed", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();

			const { childProcess } = setupMocks(volume);
			const stderrText = captureStderr();

			seedInto(volume);
			volume.mkdirSync(".jest-roblox/coverage", { recursive: true });
			volume.writeFileSync(
				".jest-roblox/coverage/coverage-manifest.json",
				"not valid json{{{",
			);

			const result = await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			expect(
				volume.readFileSync(
					result.manifest.files[COVERED_FILE]!.instrumentedLuauPath,
					"utf8",
				),
			).toContain("local x = 1");
			expect(stderrText()).toContain(
				"Warning: Previous coverage manifest is malformed JSON (cache discarded)\n",
			);
		});

		it("should re-instrument all when instrumenterVersion differs", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			const { childProcess } = setupMocks(volume);

			await seedIncrementalScenarioAsync(fileSystem, {
				previousInstrumenterVersion: INSTRUMENTER_VERSION - 1,
				volume,
			});

			const result = await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			expect(
				volume.readFileSync(
					result.manifest.files[COVERED_FILE]!.instrumentedLuauPath,
					"utf8",
				),
			).toContain("local x = 1");
		});

		it("should re-instrument all when manifest file record lacks sourceHash", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();

			const { childProcess } = setupMocks(volume);
			const stderrText = captureStderr();

			seedInto(volume);
			volume.mkdirSync("out-tsc/test", { recursive: true });
			volume.writeFileSync("out-tsc/test/init.luau", "local x = 1");

			volume.mkdirSync(".jest-roblox/coverage", { recursive: true });
			volume.writeFileSync(
				".jest-roblox/coverage/coverage-manifest.json",
				JSON.stringify({
					buildId: "prev-build-id",
					files: {
						"out-tsc/test/init.luau": { key: "out-tsc/test/init.luau" },
					},
					generatedAt: isoNow(),
					instrumenterVersion: INSTRUMENTER_VERSION,
					luauRoots: ["out-tsc/test"],
					shadowDir: ".jest-roblox/coverage",
					version: MANIFEST_VERSION,
				}),
			);

			const result = await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			expect(
				volume.readFileSync(
					result.manifest.files[COVERED_FILE]!.instrumentedLuauPath,
					"utf8",
				),
			).toContain("local x = 1");
			expect(stderrText()).toContain(
				"Warning: Previous coverage manifest is invalid (cache discarded): ",
			);
		});

		it("should handle incremental mode across multiple luauRoots", async () => {
			expect.assertions(2);

			const { childProcess, fileSystem, volume } = setupMemoryMocks();
			seedPackageRoots(volume);

			const coreRecord = packageRecord({ name: "core", source: "local a = 1" });
			const utilsRecord = packageRecord({ name: "utils", source: "local b = 2" });
			writeShadowFiles(volume, [coreRecord, utilsRecord]);

			volume.mkdirSync(".jest-roblox/place", { recursive: true });
			volume.writeFileSync(".jest-roblox/place/game.rbxl", "RBXL");

			seedPreviousManifest(volume, {
				files: {
					"packages/core/out/init.luau": coreRecord,
					"packages/utils/out/init.luau": utilsRecord,
				},
				generatedAt: isoNow(),
				instrumenterVersion: INSTRUMENTER_VERSION,
				luauRoots: ["packages/core/out", "packages/utils/out"],
				nonInstrumentedFiles: {},
				placeFilePath: ".jest-roblox/place/game.rbxl",
				rojoInputsHash: rojoInputsHash(fileSystem, {
					rojoProjectPath: path.join(PROJECT_DIR, "default.project.json"),
					rootDirectory: PROJECT_DIR,
				}),
				shadowDir: ".jest-roblox/coverage",
				version: MANIFEST_VERSION,
			});

			const config = makeConfig({
				luauRoots: ["packages/core/out", "packages/utils/out"],
			});

			await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});
			const result = await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			expect(volume.readFileSync(coreRecord.instrumentedLuauPath, "utf8")).toBe(
				"-- instrumented",
			);
			expect(result.rebuilt).toBeFalse();
		});

		it("should force rebuild when the bake reports a write on an incremental run", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = seedFilesystem();
			const { childProcess } = setupMocks(volume);
			await prepareRootAsync({ childProcess, fileSystem });
			const result = await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
				bake: makeBake(() => true),
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			expect(result.rebuilt).toBeTrue();
		});

		it("should force rebuild when the bake mounts a stub beside the shadow", async () => {
			expect.assertions(1);

			const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

			await seedIncrementalScenarioAsync(fileSystem, { volume });

			const config = makeConfig({ luauRoots: ["out-tsc/test"] });
			const bake: ShadowBake = {
				...makeBake(() => false),
				stubMounts: () => {
					return [
						{
							absStubPath: "/cache/test/jest.config.luau",
							dataModelPath: "ReplicatedStorage",
						},
					];
				},
			};

			await prepareCoverageAsync(config, {
				bake,
				childProcess,
				fileSystem,
				instrumenter,
				tsconfigReader: noTsconfig,
			});

			expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe(
				"rebuilt RBXL",
			);
		});

		it("should not force rebuild when the bake writes nothing on an incremental run", async () => {
			expect.assertions(1);

			const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

			await seedIncrementalScenarioAsync(fileSystem, { volume });

			const config = makeConfig({ luauRoots: ["out-tsc/test"] });
			const run = vi.fn<ShadowBake["run"]>().mockReturnValue(false);

			await prepareCoverageAsync(config, {
				bake: makeBake(run),
				childProcess,
				fileSystem,
				instrumenter,
				tsconfigReader: noTsconfig,
			});

			expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe(
				"rebuilt RBXL",
			);
		});

		describe("when tracking non-luauRoot rojo inputs", () => {
			const includeProject = {
				name: "test",
				tree: {
					$className: "DataModel",
					Inc: { $path: "include" },
					Src: { $path: "out-tsc/test/client" },
				},
			};

			async function seedIncludeScenarioAsync(
				fileSystem: FileSystem,
				{ includeContent, volume }: { includeContent: string; volume: MemoryVolume },
			): Promise<void> {
				seedInto(volume);
				volume.writeFileSync(
					path.join(PROJECT_DIR, "default.project.json"),
					JSON.stringify(includeProject),
				);
				volume.mkdirSync(path.join(PROJECT_DIR, "include"), { recursive: true });
				volume.writeFileSync(
					path.join(PROJECT_DIR, "include/RuntimeLib.lua"),
					includeContent,
				);

				const record = makeFileRecord({ key: "out-tsc/test/init.luau" });
				volume.mkdirSync(".jest-roblox/coverage/out-tsc/test", { recursive: true });
				volume.writeFileSync(record.instrumentedLuauPath, "-- instrumented");
				volume.writeFileSync(record.coverageMapPath, "{}");
				volume.mkdirSync(".jest-roblox/place", { recursive: true });
				volume.writeFileSync(".jest-roblox/place/game.rbxl", "RBXL");

				seedPreviousManifest(volume, {
					files: { "out-tsc/test/init.luau": record },
					generatedAt: isoNow(),
					instrumenterVersion: INSTRUMENTER_VERSION,
					luauRoots: ["out-tsc/test"],
					nonInstrumentedFiles: {},
					placeFilePath: ".jest-roblox/place/game.rbxl",
					rojoInputsHash: rojoInputsHash(fileSystem, {
						mountedFiles: [path.join(PROJECT_DIR, "include/RuntimeLib.lua")],
						rojoProjectPath: path.join(PROJECT_DIR, "default.project.json"),
						rootDirectory: PROJECT_DIR,
					}),
					shadowDir: ".jest-roblox/coverage",
					version: MANIFEST_VERSION,
				});
			}

			function seedValidBuildManifest(volume: MemoryVolume): void {
				writeValidBuildManifest(volume);
			}

			it("should rebuild when a non-luauRoot mount's file changes", async () => {
				expect.assertions(1);

				const { fileSystem, volume } = createMemoryFileSystem();

				const { childProcess, instrumenter } = setupMocks(volume);
				await seedIncludeScenarioAsync(fileSystem, { includeContent: "-- v1", volume });
				await prepareRootAsync({ childProcess, fileSystem, instrumenter });
				volume.writeFileSync(path.join(PROJECT_DIR, "include/RuntimeLib.lua"), "-- v2");

				await prepareRootAsync({ childProcess, fileSystem, instrumenter });

				expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe(
					"rebuilt RBXL",
				);
			});

			it("should reuse the place and log when rojo inputs are unchanged", async () => {
				expect.assertions(2);

				const { fileSystem, volume } = createMemoryFileSystem();

				const { childProcess, instrumenter } = setupMocks(volume);
				const stderrText = captureStderr();
				await seedIncludeScenarioAsync(fileSystem, { includeContent: "-- v1", volume });
				seedValidBuildManifest(volume);
				await prepareRootAsync({ childProcess, fileSystem });

				await prepareRootAsync({ childProcess, fileSystem, instrumenter });

				expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe(
					"rebuilt RBXL",
				);
				expect(stderrText()).toContain("Reusing cached coverage place");
			});

			it("should reject an invalid project even when a place is cached", async () => {
				expect.assertions(1);

				const { fileSystem, volume } = createMemoryFileSystem();
				const { childProcess } = setupMocks(volume);
				await seedIncludeScenarioAsync(fileSystem, { includeContent: "-- v1", volume });
				await prepareRootAsync({ childProcess, fileSystem });
				volume.writeFileSync(
					path.join(PROJECT_DIR, "default.project.json"),
					"invalid json",
				);

				await expect(prepareRootAsync({ childProcess, fileSystem })).rejects.toThrow(
					"Failed to parse Rojo project",
				);
			});
		});

		describe("when syncing non-instrumented files", () => {
			it("should copy spec files to shadow dir on first run", async () => {
				expect.assertions(1);

				const { fileSystem, volume } = createMemoryFileSystem();

				seedInto(volume);
				volume.writeFileSync("out-tsc/test/init.spec.luau", "-- test code");
				const { childProcess, instrumenter } = setupMocks(volume);
				await prepareRootAsync({ childProcess, fileSystem, instrumenter });

				expect(
					volume.readFileSync(
						".jest-roblox/coverage/out-tsc/test/init.spec.luau",
						"utf-8",
					),
				).toBe("-- test code");
			});

			it("should update changed spec files during incremental run", async () => {
				expect.assertions(1);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();
				await seedCachedSpecAsync({ fileSystem, specContent: "-- old test", volume });
				volume.writeFileSync("out-tsc/test/init.spec.luau", "-- new test");

				await prepareRootAsync({ childProcess, fileSystem, instrumenter });

				expect(
					volume.readFileSync(
						".jest-roblox/coverage/out-tsc/test/init.spec.luau",
						"utf-8",
					),
				).toBe("-- new test");
			});

			it("should skip unchanged spec files during incremental run", async () => {
				expect.assertions(1);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();
				await seedCachedSpecAsync({ fileSystem, specContent: "-- unchanged test", volume });

				const result = await prepareRootAsync({ childProcess, fileSystem, instrumenter });

				expect(
					result.manifest.nonInstrumentedFiles["out-tsc/test/init.spec.luau"]!.sourceHash,
				).toBe(sha256("-- unchanged test"));
			});

			it("should detect deleted spec files and clean up shadow copies", async () => {
				expect.assertions(2);

				const { fileSystem, volume } = createMemoryFileSystem();

				const specRecord: NonInstrumentedFileRecord = {
					shadowPath: ".jest-roblox/coverage/out-tsc/test/deleted.spec.luau",
					sourceHash: sha256("-- deleted test"),
					sourcePath: "out-tsc/test/deleted.spec.luau",
				};

				const { childProcess, instrumenter } = setupMocks(volume);
				instrumenter.mockReturnValue({});

				await seedIncrementalScenarioAsync(fileSystem, {
					previousNonInstrumentedFiles: {
						"out-tsc/test/deleted.spec.luau": specRecord,
					},
					volume,
				});
				// Source file doesn't exist (not in fileContents), but shadow was
				// seeded

				const result = await prepareRootAsync({ childProcess, fileSystem, instrumenter });

				expect(
					result.manifest.nonInstrumentedFiles["out-tsc/test/deleted.spec.luau"],
				).toBeUndefined();
				expect(
					volume.existsSync(".jest-roblox/coverage/out-tsc/test/deleted.spec.luau"),
				).toBeFalse();
			});

			it("should replace a shadow file whose source turned into a directory", async () => {
				expect.assertions(2);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				await seedIncrementalScenarioAsync(fileSystem, {
					fileContents: {
						"out-tsc/test/data/value.json": "{}",
						"out-tsc/test/init.luau": "local x = 1",
					},
					volume,
				});
				// What the last run left where this run has to put a directory.
				// The reconcile cannot clear it: it runs after the mirror, and
				// it only drops entries whose source is gone. This one's source
				// is still there, just a directory now.
				volume.writeFileSync(".jest-roblox/coverage/out-tsc/test/data", "-- stale file");

				const result = await prepareCoverageAsync(
					makeConfig({ luauRoots: ["out-tsc/test"] }),
					{ childProcess, fileSystem, instrumenter, tsconfigReader: noTsconfig },
				);

				expect(
					volume.readFileSync(
						".jest-roblox/coverage/out-tsc/test/data/value.json",
						"utf-8",
					),
				).toBe("{}");
				expect(result.rebuilt).toBeTrue();
			});

			it("should replace a shadow directory whose source turned into a file", async () => {
				expect.assertions(2);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				await seedIncrementalScenarioAsync(fileSystem, {
					fileContents: {
						"out-tsc/test/data.json": "{}",
						"out-tsc/test/init.luau": "local x = 1",
					},
					volume,
				});
				// The mirror image of the case above, seeded non-empty: the
				// whole subtree has to go, not just the entry on the path.
				volume.mkdirSync(".jest-roblox/coverage/out-tsc/test/data.json", {
					recursive: true,
				});
				volume.writeFileSync(
					".jest-roblox/coverage/out-tsc/test/data.json/value.json",
					"{}",
				);

				const result = await prepareCoverageAsync(
					makeConfig({ luauRoots: ["out-tsc/test"] }),
					{ childProcess, fileSystem, instrumenter, tsconfigReader: noTsconfig },
				);

				expect(
					volume.readFileSync(".jest-roblox/coverage/out-tsc/test/data.json", "utf-8"),
				).toBe("{}");
				expect(result.rebuilt).toBeTrue();
			});

			// Both carry-forwards ask whether the output they would keep is
			// still there, and `existsSync` says yes to a directory. An
			// interrupted run that changed a source's kind leaves exactly that,
			// and carrying the record forward would hand rojo a Folder under
			// the name a file should have, silently, since nothing throws.
			it("should re-copy when the recorded shadow path became a directory", async () => {
				expect.assertions(1);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();
				const specRecord = await seedCachedSpecAsync({
					fileSystem,
					specContent: "-- spec",
					volume,
				});
				volume.rmSync(specRecord.shadowPath);
				volume.mkdirSync(specRecord.shadowPath, { recursive: true });

				await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				});

				expect(volume.readFileSync(specRecord.shadowPath, "utf-8")).toBe("-- spec");
			});

			it("should re-instrument when the recorded twin became a directory", async () => {
				expect.assertions(1);

				const { childProcess, fileSystem, volume } = setupMemoryMocks();

				await seedIncrementalScenarioAsync(fileSystem, { volume });
				const twin = ".jest-roblox/coverage/out-tsc/test/init.luau";
				volume.rmSync(twin);
				volume.mkdirSync(twin, { recursive: true });

				await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
					childProcess,
					fileSystem,
					tsconfigReader: noTsconfig,
				});

				expect(volume.readFileSync(twin, "utf8")).toContain("__cov");
			});

			it("should remove orphaned non-luau files from the shadow when source is deleted", async () => {
				expect.assertions(1);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				await seedIncrementalScenarioAsync(fileSystem, { volume });
				// A meta file a prior cold run copied in, whose source was later
				// deleted. It is neither instrumented nor a spec/test/snap file,
				// so only reconciling the shadow against source can drop it.
				volume.writeFileSync(
					".jest-roblox/coverage/out-tsc/test/init.meta.json",
					'{"className":"Folder"}',
				);

				await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				});

				expect(
					volume.existsSync(".jest-roblox/coverage/out-tsc/test/init.meta.json"),
				).toBeFalse();
			});

			it("should keep and sync non-luau files whose source still exists", async () => {
				expect.assertions(2);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				await seedIncrementalScenarioAsync(fileSystem, {
					fileContents: {
						"out-tsc/test/init.luau": "local x = 1",
						"out-tsc/test/init.meta.json": '{"className":"Folder"}',
					},
					volume,
				});

				const result = await prepareCoverageAsync(
					makeConfig({ luauRoots: ["out-tsc/test"] }),
					{ childProcess, fileSystem, instrumenter, tsconfigReader: noTsconfig },
				);

				expect(
					volume.readFileSync(
						".jest-roblox/coverage/out-tsc/test/init.meta.json",
						"utf-8",
					),
				).toBe('{"className":"Folder"}');
				expect(
					result.manifest.nonInstrumentedFiles["out-tsc/test/init.meta.json"],
				).toBeDefined();
			});

			// The three failure shapes a warm run takes when the copy-ignore
			// list moves under it: a carried-forward record for a file the
			// reconcile just deleted, an orphan cov-map keeping that file in
			// the report at 0%, and (the hard one) a new file lost entirely
			// because `instrumentable.size` cancelled against a newly-ignored
			// one and faked a full cache hit. All three are the same bug: the
			// warm path reasons from counts a manifest the old list wrote.
			it("should rebuild cold when the copy-ignore list changed since the manifest", async () => {
				expect.assertions(2);

				const { childProcess, fileSystem, volume } = setupMemoryMocks();

				await seedIncrementalScenarioAsync(fileSystem, { volume });
				volume.writeFileSync("out-tsc/test/new.luau", "local fresh = 1");

				const result = await prepareCoverageAsync(
					makeConfig({
						coverageCopyIgnorePatterns: ["init.luau"],
						luauRoots: ["out-tsc/test"],
					}),
					{ childProcess, fileSystem, tsconfigReader: noTsconfig },
				);

				expect(result.manifest.files).not.toHaveProperty("out-tsc/test/init.luau");
				expect(
					volume.readFileSync(
						result.manifest.files["out-tsc/test/new.luau"]!.instrumentedLuauPath,
						"utf8",
					),
				).toContain("local fresh = 1");
			});

			it("should reuse the cache when the copy-ignore list only reorders", async () => {
				expect.assertions(1);

				const { childProcess, fileSystem, volume } = setupMemoryMocks();

				await seedIncrementalScenarioAsync(fileSystem, { volume });
				await prepareCoverageAsync(
					makeConfig({
						coverageCopyIgnorePatterns: [
							...createResolvedConfig().coverageCopyIgnorePatterns,
						].toReversed(),
						luauRoots: ["out-tsc/test"],
					}),
					{ childProcess, fileSystem, tsconfigReader: noTsconfig },
				);

				expect(
					volume.readFileSync(".jest-roblox/coverage/out-tsc/test/init.luau", "utf8"),
				).toBe("-- instrumented");
			});

			it("should keep a cov-map sidecar a user JSON pattern would match", async () => {
				expect.assertions(1);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				await seedIncrementalScenarioAsync(fileSystem, {
					copyIgnoreHash: digestCopyIgnore(["**/*.json"]),
					volume,
				});
				volume.writeFileSync(".jest-roblox/coverage/out-tsc/test/init.cov-map.json", "{}");

				// The sidecar is instrumenter output, not a copy, so the list
				// has no say over it. Deleting it would leave the manifest
				// record pointing at a missing map, and the report drops that
				// module without saying so.
				await prepareCoverageAsync(
					makeConfig({
						coverageCopyIgnorePatterns: ["**/*.json"],
						luauRoots: ["out-tsc/test"],
					}),
					{ childProcess, fileSystem, instrumenter, tsconfigReader: noTsconfig },
				);

				expect(
					volume.existsSync(".jest-roblox/coverage/out-tsc/test/init.cov-map.json"),
				).toBeTrue();
			});

			it("should remove declaration artifacts an earlier run copied in", async () => {
				expect.assertions(2);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				await seedIncrementalScenarioAsync(fileSystem, {
					fileContents: {
						"out-tsc/test/init.d.ts": "export {};",
						"out-tsc/test/init.d.ts.map": "{}",
						"out-tsc/test/init.luau": "local x = 1",
					},
					volume,
				});
				// Copied in by a cold run that predates the exclusion. Both
				// sources still exist, so only the artifact rule can drop them.
				volume.writeFileSync(".jest-roblox/coverage/out-tsc/test/init.d.ts", "export {};");
				volume.writeFileSync(".jest-roblox/coverage/out-tsc/test/init.d.ts.map", "{}");

				await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				});

				expect(
					volume.existsSync(".jest-roblox/coverage/out-tsc/test/init.d.ts"),
				).toBeFalse();
				expect(
					volume.existsSync(".jest-roblox/coverage/out-tsc/test/init.d.ts.map"),
				).toBeFalse();
			});

			it("should remove an orphaned cov-map sidecar when its base source is gone", async () => {
				expect.assertions(1);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				await seedIncrementalScenarioAsync(fileSystem, { volume });
				volume.writeFileSync(".jest-roblox/coverage/out-tsc/test/gone.cov-map.json", "{}");

				await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				});

				expect(
					volume.existsSync(".jest-roblox/coverage/out-tsc/test/gone.cov-map.json"),
				).toBeFalse();
			});

			it("should keep a cov-map sidecar whose base source still exists", async () => {
				expect.assertions(1);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				await seedIncrementalScenarioAsync(fileSystem, { volume });
				// init.luau source is seeded by default; its sidecar must
				// survive.
				volume.writeFileSync(".jest-roblox/coverage/out-tsc/test/init.cov-map.json", "{}");

				await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				});

				expect(
					volume.existsSync(".jest-roblox/coverage/out-tsc/test/init.cov-map.json"),
				).toBeTrue();
			});

			it("should remove an orphaned shadow directory when its source directory is gone", async () => {
				expect.assertions(2);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				// The `foo/index.ts` -> `foo.ts` rename, which turns a source
				// directory into a sibling file. Unlinking the orphaned
				// `init.luau` alone leaves an empty `dir/`, and rojo still mounts
				// that as a Folder named `dir` beside the ModuleScript
				// `dir.luau`.
				await seedIncrementalScenarioAsync(fileSystem, {
					fileContents: {
						"out-tsc/test/dir.luau": "local x = 1",
						"out-tsc/test/init.luau": "local x = 1",
					},
					volume,
				});
				volume.mkdirSync(".jest-roblox/coverage/out-tsc/test/dir", { recursive: true });
				volume.writeFileSync(
					".jest-roblox/coverage/out-tsc/test/dir/init.luau",
					"-- stale",
				);

				await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				});

				expect(
					volume.existsSync(".jest-roblox/coverage/out-tsc/test/dir/init.luau"),
				).toBeFalse();
				expect(volume.existsSync(".jest-roblox/coverage/out-tsc/test/dir")).toBeFalse();
			});

			it("should collapse a nested orphaned shadow directory tree in one pass", async () => {
				expect.assertions(1);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				await seedIncrementalScenarioAsync(fileSystem, { volume });
				// `a` is only empty once `a/b/c` and `a/b` are gone, so the prune
				// has to run bottom-up to reach it in this run rather than the
				// third one.
				volume.mkdirSync(".jest-roblox/coverage/out-tsc/test/a/b/c", { recursive: true });
				volume.writeFileSync(
					".jest-roblox/coverage/out-tsc/test/a/b/c/gone.luau",
					"-- stale",
				);

				await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				});

				expect(volume.existsSync(".jest-roblox/coverage/out-tsc/test/a")).toBeFalse();
			});

			it("should rebuild when an empty source directory appears on a warm run", async () => {
				expect.assertions(2);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				await seedIncrementalScenarioAsync(fileSystem, { volume });
				// No file write reaches a directory with nothing in it, so the
				// mirror is the only thing that can notice one appeared, and
				// rojo builds a Folder for it, so the place has to be rebuilt.
				volume.mkdirSync("out-tsc/test/empty", { recursive: true });

				const result = await prepareCoverageAsync(
					makeConfig({ luauRoots: ["out-tsc/test"] }),
					{ childProcess, fileSystem, instrumenter, tsconfigReader: noTsconfig },
				);

				expect(volume.existsSync(".jest-roblox/coverage/out-tsc/test/empty")).toBeTrue();
				expect(result.rebuilt).toBeTrue();
			});

			it("should keep an empty shadow directory whose source directory still exists", async () => {
				expect.assertions(1);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				await seedIncrementalScenarioAsync(fileSystem, { volume });
				// A cold run mirrors empty source directories, and rojo mounts
				// each as a Folder. A warm run must agree, so an empty shadow
				// directory survives for as long as its source directory does.
				volume.mkdirSync("out-tsc/test/empty", { recursive: true });
				volume.mkdirSync(".jest-roblox/coverage/out-tsc/test/empty", { recursive: true });

				await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				});

				expect(volume.existsSync(".jest-roblox/coverage/out-tsc/test/empty")).toBeTrue();
			});

			it("should keep a skipped directory while its parent source survives", async () => {
				expect.assertions(1);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				// The walk never descends into `node_modules`, so it cannot judge
				// whether that subtree is orphaned. While the parent source is
				// there, neither is orphaned.
				await seedIncrementalScenarioAsync(fileSystem, {
					fileContents: {
						"out-tsc/test/init.luau": "local x = 1",
						"out-tsc/test/vendor/keep.luau": "local x = 1",
					},
					volume,
				});
				volume.mkdirSync(".jest-roblox/coverage/out-tsc/test/vendor/node_modules", {
					recursive: true,
				});
				volume.writeFileSync(
					".jest-roblox/coverage/out-tsc/test/vendor/node_modules/dep.luau",
					"-- vendored",
				);

				await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				});

				expect(
					volume.existsSync(
						".jest-roblox/coverage/out-tsc/test/vendor/node_modules/dep.luau",
					),
				).toBeTrue();
			});

			it("should remove a skipped directory once its parent source is gone", async () => {
				expect.assertions(1);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				await seedIncrementalScenarioAsync(fileSystem, { volume });
				// Nothing under an orphaned parent can be anything but orphaned,
				// so the skip must not veto the parent’s removal. Otherwise a
				// stale `vendor/` survives beside a fresh `vendor.luau`.
				volume.mkdirSync(".jest-roblox/coverage/out-tsc/test/vendor/node_modules", {
					recursive: true,
				});
				volume.writeFileSync(
					".jest-roblox/coverage/out-tsc/test/vendor/node_modules/dep.luau",
					"-- vendored",
				);

				await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				});

				expect(volume.existsSync(".jest-roblox/coverage/out-tsc/test/vendor")).toBeFalse();
			});

			it("should force a rebuild when an orphaned shadow directory is removed", async () => {
				expect.assertions(1);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				await seedIncrementalScenarioAsync(fileSystem, { volume });
				volume.mkdirSync(".jest-roblox/coverage/out-tsc/test/gone", { recursive: true });

				await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				});

				expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe(
					"rebuilt RBXL",
				);
			});

			it("should force a rebuild when an orphaned non-luau file is removed", async () => {
				expect.assertions(1);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				await seedIncrementalScenarioAsync(fileSystem, { volume });
				volume.writeFileSync(".jest-roblox/coverage/out-tsc/test/init.meta.json", "{}");

				await prepareCoverageAsync(makeConfig({ luauRoots: ["out-tsc/test"] }), {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				});

				expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe(
					"rebuilt RBXL",
				);
			});

			it("should force a cold rebuild when a luauRoot is dropped from the set", async () => {
				expect.assertions(2);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				await seedIncrementalScenarioAsync(fileSystem, { volume });
				// The prior run also covered a second root, now gone from config.
				// The per-root reconcile never walks it, so the set-change guard
				// must cold-rebuild to purge its orphaned shadow subtree.
				const manifestPath = ".jest-roblox/coverage/coverage-manifest.json";
				const previous = readCoverageManifestFile(volume, manifestPath);
				previous.luauRoots = ["out-tsc/test", "out-tsc/extra"];
				volume.writeFileSync(manifestPath, JSON.stringify(previous));
				volume.mkdirSync(".jest-roblox/coverage/out-tsc/extra", { recursive: true });
				volume.writeFileSync(".jest-roblox/coverage/out-tsc/extra/stale.luau", "-- stale");

				const result = await prepareCoverageAsync(
					makeConfig({ luauRoots: ["out-tsc/test"] }),
					{ childProcess, fileSystem, instrumenter, tsconfigReader: noTsconfig },
				);

				expect(result.rebuilt).toBeTrue();
				expect(
					volume.existsSync(".jest-roblox/coverage/out-tsc/extra/stale.luau"),
				).toBeFalse();
			});

			it("should set changed=true when spec file changes (triggers rojo rebuild)", async () => {
				expect.assertions(1);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();
				await seedCachedSpecAsync({ fileSystem, specContent: "-- old test", volume });
				volume.writeFileSync("out-tsc/test/init.spec.luau", "-- new test");

				await prepareRootAsync({ childProcess, fileSystem, instrumenter });

				expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe(
					"rebuilt RBXL",
				);
			});

			it("should track non-instrumented files in manifest", async () => {
				expect.assertions(2);

				const { fileSystem, volume } = createMemoryFileSystem();

				seedInto(volume);
				volume.writeFileSync("out-tsc/test/init.spec.luau", "-- test code");
				const { childProcess, instrumenter } = setupMocks(volume);
				const result = await prepareRootAsync({ childProcess, fileSystem, instrumenter });

				const record = result.manifest.nonInstrumentedFiles["out-tsc/test/init.spec.luau"];

				expect(record).toBeDefined();
				expect(record!.sourceHash).toBe(sha256("-- test code"));
			});

			it("should force cold rebuild when previous manifest lacks nonInstrumentedFiles", async () => {
				expect.assertions(1);

				const { fileSystem, volume } = createMemoryFileSystem();

				const { childProcess } = setupMocks(volume);

				seedInto(volume);
				volume.mkdirSync("out-tsc/test", { recursive: true });
				volume.writeFileSync("out-tsc/test/init.luau", "local x = 1");

				// Seed a manifest WITHOUT nonInstrumentedFiles
				volume.mkdirSync(".jest-roblox/coverage", { recursive: true });
				volume.writeFileSync(
					".jest-roblox/coverage/coverage-manifest.json",
					JSON.stringify({
						buildId: "prev-build-id",
						files: {
							"out-tsc/test/init.luau": makeFileRecord({
								key: "out-tsc/test/init.luau",
							}),
						},
						generatedAt: isoNow(),
						instrumenterVersion: INSTRUMENTER_VERSION,
						luauRoots: ["out-tsc/test"],
						shadowDir: ".jest-roblox/coverage",
						version: MANIFEST_VERSION,
					}),
				);

				const result = await prepareRootAsync({ childProcess, fileSystem });

				expect(
					volume.readFileSync(
						result.manifest.files["out-tsc/test/init.luau"]!.instrumentedLuauPath,
						"utf8",
					),
				).toContain("__cov");
			});

			it("should reuse the place when a deleted file's shadow copy is already gone", async () => {
				expect.assertions(2);

				const { fileSystem, volume } = createMemoryFileSystem();

				const specRecord: NonInstrumentedFileRecord = {
					shadowPath: ".jest-roblox/coverage/out-tsc/test/gone.spec.luau",
					sourceHash: sha256("-- gone"),
					sourcePath: "out-tsc/test/gone.spec.luau",
				};

				const { childProcess, instrumenter } = setupMocks(volume);
				instrumenter.mockReturnValue({});

				await seedIncrementalScenarioAsync(fileSystem, {
					previousNonInstrumentedFiles: {
						"out-tsc/test/gone.spec.luau": specRecord,
					},
					volume,
				});
				volume.unlinkSync(".jest-roblox/coverage/out-tsc/test/gone.spec.luau");

				await prepareRootAsync({ childProcess, fileSystem, instrumenter });

				expect(
					volume.existsSync(".jest-roblox/coverage/out-tsc/test/gone.spec.luau"),
				).toBeFalse();
				expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe(
					"rebuilt RBXL",
				);
			});

			it("should discover spec files in subdirectories", async () => {
				expect.assertions(1);

				const { fileSystem, volume } = createMemoryFileSystem();

				seedInto(volume);
				volume.mkdirSync("out-tsc/test/sub", { recursive: true });
				volume.writeFileSync("out-tsc/test/sub/deep.spec.luau", "-- deep test");
				const { childProcess, instrumenter } = setupMocks(volume);
				const result = await prepareRootAsync({ childProcess, fileSystem, instrumenter });

				expect(
					result.manifest.nonInstrumentedFiles["out-tsc/test/sub/deep.spec.luau"],
				).toBeDefined();
			});

			it("should not prune non-instrumented files from other roots", async () => {
				expect.assertions(1);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				// Multi-root: previous manifest has a spec in packages/core/out
				seedPackageRoots(volume);
				volume.writeFileSync("packages/core/out/init.spec.luau", "-- core spec");

				const coreRecord = packageRecord({ name: "core", source: "local a = 1" });
				const utilsRecord = packageRecord({ name: "utils", source: "local b = 2" });

				const coreSpecRecord: NonInstrumentedFileRecord = {
					shadowPath: ".jest-roblox/coverage/packages/core/out/init.spec.luau",
					sourceHash: sha256("-- core spec"),
					sourcePath: "packages/core/out/init.spec.luau",
				};

				writeShadowFiles(volume, [coreRecord, utilsRecord]);

				volume.mkdirSync(".jest-roblox/coverage/packages/core/out", { recursive: true });
				volume.writeFileSync(coreSpecRecord.shadowPath, "-- core spec");
				volume.mkdirSync(".jest-roblox/place", { recursive: true });
				volume.writeFileSync(".jest-roblox/place/game.rbxl", "RBXL");

				seedPreviousManifest(volume, {
					files: {
						"packages/core/out/init.luau": coreRecord,
						"packages/utils/out/init.luau": utilsRecord,
					},
					generatedAt: isoNow(),
					instrumenterVersion: INSTRUMENTER_VERSION,
					luauRoots: ["packages/core/out", "packages/utils/out"],
					nonInstrumentedFiles: {
						"packages/core/out/init.spec.luau": coreSpecRecord,
					},
					placeFilePath: ".jest-roblox/place/game.rbxl",
					shadowDir: ".jest-roblox/coverage",
					version: MANIFEST_VERSION,
				});

				const config = makeConfig({
					luauRoots: ["packages/core/out", "packages/utils/out"],
				});

				const result = await prepareCoverageAsync(config, {
					childProcess,
					fileSystem,
					instrumenter,
					tsconfigReader: noTsconfig,
				});

				// Core spec should still be tracked (not pruned by utils root
				// processing)
				expect(
					result.manifest.nonInstrumentedFiles["packages/core/out/init.spec.luau"],
				).toBeDefined();
			});

			it("should skip node_modules and dot directories when discovering spec files", async () => {
				expect.assertions(2);

				const { fileSystem, volume } = createMemoryFileSystem();

				seedInto(volume);
				volume.mkdirSync("out-tsc/test/node_modules", { recursive: true });
				volume.writeFileSync("out-tsc/test/node_modules/mod.spec.luau", "-- ignored");
				volume.mkdirSync("out-tsc/test/.hidden", { recursive: true });
				volume.writeFileSync("out-tsc/test/.hidden/secret.spec.luau", "-- ignored");
				const { childProcess, instrumenter } = setupMocks(volume);
				const result = await prepareRootAsync({ childProcess, fileSystem, instrumenter });

				expect(
					result.manifest.nonInstrumentedFiles["out-tsc/test/node_modules/mod.spec.luau"],
				).toBeUndefined();
				expect(
					result.manifest.nonInstrumentedFiles["out-tsc/test/.hidden/secret.spec.luau"],
				).toBeUndefined();
			});

			it("should handle file rename across categories (source to spec)", async () => {
				expect.assertions(2);

				const { childProcess, fileSystem, instrumenter, volume } = setupMemoryMocks();

				// Previous manifest has init.luau as instrumented source
				// Now the file has been renamed to init.spec.luau
				await seedIncrementalScenarioAsync(fileSystem, {
					fileContents: {
						"out-tsc/test/helper.spec.luau": "-- was a source file",
						"out-tsc/test/init.luau": "local x = 1",
					},
					volume,
				});

				const result = await prepareRootAsync({ childProcess, fileSystem, instrumenter });

				// New spec file should be tracked as non-instrumented
				expect(
					result.manifest.nonInstrumentedFiles["out-tsc/test/helper.spec.luau"],
				).toBeDefined();
				// Source file should still be in instrumented files (carried
				// forward)
				expect(result.manifest.files["out-tsc/test/init.luau"]).toBeDefined();
			});
		});
	});

	describe("when a bake is provided", () => {
		it("should run the bake against the shadow layout", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = seedFilesystem();
			const { childProcess, instrumenter } = setupMocks(volume);
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });
			function run(layout: ShadowLayout): boolean {
				volume.writeFileSync(path.join(layout.root, "baked.txt"), "baked content");
				return true;
			}

			await prepareCoverageAsync(config, {
				bake: makeBake(run),
				childProcess,
				fileSystem,
				instrumenter,
				tsconfigReader: noTsconfig,
			});

			expect(volume.readFileSync(".jest-roblox/coverage/baked.txt", "utf8")).toBe(
				"baked content",
			);
			expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe(
				"rebuilt RBXL",
			);
		});

		it("should report the callback as staging rather than as coverage", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = seedFilesystem();
			const { childProcess, instrumenter } = setupMocks(volume);
			const config = makeConfig({ luauRoots: ["out-tsc/test"] });
			// The hook is the stub bake, which a non-coverage run pays too.
			// Frozen clock apart from the hook, so whatever it costs is the whole
			// difference between the two phases.
			const clock = movableClockCollector(1_000);
			const run = vi.fn<ShadowBake["run"]>(() => {
				clock.advance(90);
				return false;
			});

			const result = await prepareCoverageAsync(config, {
				bake: makeBake(run),
				childProcess,
				fileSystem,
				instrumenter,
				timing: clock.timing,
				tsconfigReader: noTsconfig,
			});

			expect(result.instrumentMs).toBe(0);
			expect(result.stagingMs).toBe(90);
		});

		it("should skip callback when not provided", async () => {
			expect.assertions(1);

			const { volume } = await prepareSeededAsync();

			expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe(
				"rebuilt RBXL",
			);
		});
	});

	describe("when using multiple roots", () => {
		it("should instrument each root separately", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();

			seedPackageRoots(volume, "test-utils");

			const { childProcess } = setupMocks(volume);
			const config = makeConfig({
				luauRoots: ["packages/core/out", "packages/test-utils/out"],
			});

			const result = await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				tsconfigReader: noTsconfig,
			});

			expect(Object.keys(result.manifest.files)).toStrictEqual([
				"packages/core/out/init.luau",
				"packages/test-utils/out/init.luau",
			]);
			expect(
				volume.readFileSync(
					result.manifest.files["packages/test-utils/out/init.luau"]!
						.instrumentedLuauPath,
					"utf8",
				),
			).toContain("__cov");
		});

		it("should mirror each root into its own shadow directory", async () => {
			expect.assertions(2);

			const { fileSystem, volume } = createMemoryFileSystem();

			seedPackageRoots(volume, "test-utils");
			volume.writeFileSync("packages/core/out/init.spec.luau", "local a = 1");
			volume.writeFileSync("packages/test-utils/out/init.spec.luau", "local b = 2");

			const { childProcess, instrumenter } = setupMocks(volume);
			const config = makeConfig({
				luauRoots: ["packages/core/out", "packages/test-utils/out"],
			});

			await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				instrumenter,
				tsconfigReader: noTsconfig,
			});

			expect(
				volume.readFileSync(
					".jest-roblox/coverage/packages/core/out/init.spec.luau",
					"utf-8",
				),
			).toBe("local a = 1");
			expect(
				volume.readFileSync(
					".jest-roblox/coverage/packages/test-utils/out/init.spec.luau",
					"utf-8",
				),
			).toBe("local b = 2");
		});

		it("should write a single manifest with all roots", async () => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			seedPackageRoots(volume, "test-utils");

			const { childProcess, instrumenter } = setupMocks(volume);
			const config = makeConfig({
				luauRoots: ["packages/core/out", "packages/test-utils/out"],
			});

			const result = await prepareCoverageAsync(config, {
				childProcess,
				fileSystem,
				instrumenter,
				tsconfigReader: noTsconfig,
			});

			expect(result.manifest.luauRoots).toStrictEqual([
				"packages/core/out",
				"packages/test-utils/out",
			]);
		});
	});
});

describe(toCoverageArtifacts, () => {
	it("should project a prepare result and the caller's projects onto one record", async () => {
		expect.assertions(1);

		const result: PrepareCoverageResult = {
			buildId: "build-7",
			coveragePlace: { hash: "cov-hash", path: ".jest-roblox/place/game.rbxl" },
			files: { "out/init.luau": { sourceHash: "h" } },
			instrumentMs: 0,
			manifest: fromAny({ generatedAt: "2026-07-25T00:00:00.000Z" }),
			placeFile: ".jest-roblox/place/game.rbxl",
			rebuilt: true,
			stagingMs: 0,
		};
		const projects: Array<BuildManifestProject> = [
			{
				displayName: "client",
				projectDataModelPath: "ReplicatedStorage/client",
				setupFiles: [],
				setupFilesAfterEnv: [],
				testMatch: ["**/*.spec"],
			},
		];

		expect(toCoverageArtifacts(result, projects)).toStrictEqual({
			buildId: "build-7",
			coveragePlace: { hash: "cov-hash", path: ".jest-roblox/place/game.rbxl" },
			files: { "out/init.luau": { sourceHash: "h" } },
			generatedAt: "2026-07-25T00:00:00.000Z",
			projects,
			rebuilt: true,
		});
	});
});

describe("narrowing to the coverage universe", () => {
	/**
	 * A mount whose probes all sit in one subtree, with unprobed siblings
	 * either side and a loose file the mount itself owns.
	 * @param volume - Volume the mount is written to.
	 */
	function seedNarrowableRoot(volume: MemoryVolume): void {
		// Rooted at the invocation directory, which is what `rootDir` is in a
		// real single-mode run: the mount the demote rewrites has to resolve to
		// the same directory the shadow walk reads.
		volume.mkdirSync(process.cwd(), { recursive: true });
		volume.writeFileSync(
			"default.project.json",
			JSON.stringify({
				name: "test",
				tree: { $className: "DataModel", ReplicatedStorage: { $path: "out" } },
			}),
		);
		volume.mkdirSync("out/modules/ecs", { recursive: true });
		volume.mkdirSync("out/client", { recursive: true });
		volume.writeFileSync("out/modules/ecs/world.luau", "local x = 1");
		volume.writeFileSync("out/modules/net.luau", "local x = 2");
		volume.writeFileSync("out/client/button.luau", "local x = 3");
		volume.writeFileSync("out/loose.luau", "local x = 4");
	}

	async function prepareNarrowedAsync() {
		const { fileSystem, volume } = createMemoryFileSystem();
		seedNarrowableRoot(volume);
		const mocks = setupMocks(volume);
		const config = makeConfig({
			collectCoverageFrom: ["**/ecs/**"],
			luauRoots: ["out"],
			rootDir: process.cwd(),
		});
		const result = await prepareCoverageAsync(config, {
			childProcess: mocks.childProcess,
			fileSystem,
			instrumenter: mocks.instrumenter,
			tsconfigReader: noTsconfig,
		});

		return { ...mocks, config, fileSystem, result, volume };
	}

	it("should mirror only the subtrees the universe resolves to", async () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedNarrowableRoot(volume);
		// Asserted through a file the mirror owns: the instrumenter is mocked
		// here, and no pass copies a root wholesale, so a probed `.luau` has
		// nothing writing it into the shadow.
		volume.writeFileSync("out/modules/ecs/world.spec.luau", "-- spec");
		const { childProcess, instrumenter } = setupMocks(volume);
		const config = makeConfig({
			collectCoverageFrom: ["**/ecs/**"],
			luauRoots: ["out"],
			rootDir: process.cwd(),
		});

		await prepareCoverageAsync(config, {
			childProcess,
			fileSystem,
			instrumenter,
			tsconfigReader: noTsconfig,
		});

		expect(
			volume.existsSync(".jest-roblox/coverage/out/modules/ecs/world.spec.luau"),
		).toBeTrue();
		expect(volume.existsSync(".jest-roblox/coverage/out/client/button.luau")).toBeFalse();
		expect(volume.existsSync(".jest-roblox/coverage/out/modules/net.luau")).toBeFalse();
	});

	it("should carry each demoted level's loose files onto the spine", async () => {
		expect.assertions(3);

		const { result, volume } = await prepareNarrowedAsync();

		expect(volume.existsSync(".jest-roblox/coverage/.spine/out/.self/loose.luau")).toBeTrue();
		expect(
			volume.existsSync(".jest-roblox/coverage/.spine/out/modules/.self/net.luau"),
		).toBeTrue();
		expect(Object.keys(result.manifest.nonInstrumentedFiles)).toIncludeAllMembers([
			"out/loose.luau",
			"out/modules/net.luau",
		]);
	});

	it("should refill a spine leaf a warm run recorded elsewhere", async () => {
		expect.assertions(2);

		const { childProcess, config, fileSystem, instrumenter, volume } =
			await prepareNarrowedAsync();
		const mirrored = [
			{ name: "loose.luau", level: "out" },
			{ name: "net.luau", level: "out/modules" },
		];
		for (const { name, level } of mirrored) {
			const leaf = `.jest-roblox/coverage/.spine/${level}/.self`;
			volume.renameSync(`${leaf}/${name}`, `.jest-roblox/coverage/.spine/${level}/${name}`);
			volume.rmdirSync(leaf);
		}

		const manifestPath = ".jest-roblox/coverage/coverage-manifest.json";
		volume.writeFileSync(
			manifestPath,
			String(volume.readFileSync(manifestPath)).replaceAll("/.self/", "/"),
		);

		const result = await prepareCoverageAsync(config, {
			childProcess,
			fileSystem,
			instrumenter,
			tsconfigReader: noTsconfig,
		});

		expect(volume.existsSync(".jest-roblox/coverage/.spine/out/.self/loose.luau")).toBeTrue();
		expect(result.rebuilt).toBeTrue();
	});

	it("should record the narrowed roots in the manifest", async () => {
		expect.assertions(1);

		const { result } = await prepareNarrowedAsync();

		expect(result.manifest.luauRoots).toStrictEqual(["out/modules/ecs"]);
	});

	it("should leave a mount the universe never reaches out of the shadow", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedNarrowableRoot(volume);
		const { childProcess, instrumenter } = setupMocks(volume);
		const config = makeConfig({
			collectCoverageFrom: ["**/nothing-here/**"],
			luauRoots: ["out"],
			rootDir: process.cwd(),
		});

		const result = await prepareCoverageAsync(config, {
			childProcess,
			fileSystem,
			instrumenter,
			tsconfigReader: noTsconfig,
		});

		expect(result.manifest.luauRoots).toStrictEqual([]);
		expect(volume.existsSync(".jest-roblox/coverage/out")).toBeFalse();
	});

	it("should hand the bake the spine copy for a demoted directory", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedNarrowableRoot(volume);
		const { childProcess, instrumenter } = setupMocks(volume);
		const config = makeConfig({
			collectCoverageFrom: ["**/ecs/**"],
			luauRoots: ["out"],
			rootDir: process.cwd(),
		});
		const layouts: Array<ShadowLayout> = [];

		await prepareCoverageAsync(config, {
			bake: makeBake((layout) => {
				layouts.push(layout);
				return false;
			}),
			childProcess,
			fileSystem,
			instrumenter,
			tsconfigReader: noTsconfig,
		});

		// The place mounts the spine in `out`'s place, so anything baked into
		// the mirror would never reach it.
		expect(layouts[0]!.mountedDirectory("out")).toBe(".jest-roblox/coverage/.spine/out/.self");
		expect(layouts[0]!.mountedDirectory("out/modules/ecs")).toBe(
			".jest-roblox/coverage/out/modules/ecs",
		);
	});
});

describe("when hashing the rojo build inputs", () => {
	it("should not re-read an unchanged mount on the next run", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = seedFilesystem();
		volume.mkdirSync(path.join(PROJECT_DIR, "assets"), { recursive: true });
		writeAgedFile(fileSystem, path.join(PROJECT_DIR, "assets/model.txt"), "one");
		volume.writeFileSync(
			path.join(PROJECT_DIR, "default.project.json"),
			JSON.stringify({
				name: "test",
				tree: { $className: "DataModel", Assets: { $path: "assets" } },
			}),
		);
		const { childProcess, instrumenter } = setupMocks(volume);
		const config = makeConfig({ luauRoots: ["out-tsc/test"] });
		await prepareCoverageAsync(config, {
			childProcess,
			fileSystem,
			instrumenter,
			tsconfigReader: noTsconfig,
		});

		const readFile = vi.spyOn(fileSystem.promises, "readFile");
		await prepareCoverageAsync(config, {
			childProcess,
			fileSystem,
			instrumenter,
			tsconfigReader: noTsconfig,
		});

		expect(readFile).not.toHaveBeenCalledWith(path.join(PROJECT_DIR, "assets/model.txt"));
	});
});

describe("when a run bakes generated jest.config stubs into the shadow", () => {
	/** One rojo mount per project, by the directory each one covers. */
	const mounts = {
		server: "game.ServerScriptService",
		shared: "game.ReplicatedStorage",
	};

	/**
	 * Two rojo mounts under one coverage root, neither with a user config.
	 * @param volume - Volume the mounts are written to.
	 */
	function seedMultiMountRoot(volume: MemoryVolume): void {
		// Rooted at the invocation directory, which is what `rootDir` is in a
		// real single-mode run: the mounts the stubs are keyed on have to
		// resolve to the same directories the shadow walk reads.
		volume.mkdirSync(process.cwd(), { recursive: true });
		volume.writeFileSync(
			"default.project.json",
			JSON.stringify({
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { $path: "out/shared" },
					ServerScriptService: { $path: "out/server" },
				},
			}),
		);

		for (const name of Object.keys(mounts)) {
			volume.mkdirSync(`out/${name}`, { recursive: true });
			volume.writeFileSync(`out/${name}/init.luau`, `local ${name} = 1`);
		}
	}

	function stageBake(
		fileSystem: FileSystem,
		extraMounts: Record<string, string> = {},
	): {
		bake: ShadowBake;
		config: ResolvedConfig;
	} {
		const config = makeConfig({ luauRoots: ["out"], rootDir: process.cwd() });
		const names = Object.keys({ ...mounts, ...extraMounts });
		return {
			bake: stubBake(
				fileSystem,
				names.map((name) => `out/${name}`),
			),
			config,
		};
	}

	function setupBakedRun(extraMounts: Record<string, string> = {}) {
		const { fileSystem, volume } = createMemoryFileSystem();
		seedMultiMountRoot(volume);
		const mocks = setupMocks(volume);
		const { bake, config } = stageBake(fileSystem, extraMounts);
		async function prepareAsync(): Promise<PrepareCoverageResult> {
			return prepareCoverageAsync(config, {
				bake,
				childProcess: mocks.childProcess,
				fileSystem,
				instrumenter: mocks.instrumenter,
				tsconfigReader: noTsconfig,
			});
		}

		return { ...mocks, bake, config, fileSystem, prepareAsync, volume };
	}

	const sharedStub = ".jest-roblox/coverage/out/shared/jest.config.luau";
	const absentStub = ".jest-roblox/coverage/out/absent/jest.config.luau";

	/**
	 * A `rmSync` that refuses one path and passes everything else through, for
	 * the entry a real shadow loses to a lock or a permission.
	 * @param volume - Volume removals pass through to.
	 * @param suffix - Path suffix whose removal throws.
	 * @returns The `rmSync` stand-in.
	 */
	function refuseRemovalOf(volume: MemoryVolume, suffix: string): FileSystem["rmSync"] {
		return fromAny((target: string, options: object) => {
			if (posixPath(target).endsWith(suffix)) {
				throw new Error("EBUSY");
			}

			volume.rmSync(target, options);
		});
	}

	it("should reuse the place on a no-change rerun", async () => {
		expect.assertions(3);

		const { prepareAsync, volume } = setupBakedRun();

		const first = await prepareAsync();

		const second = await prepareAsync();

		expect(second.rebuilt).toBeFalse();
		expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe("rebuilt RBXL");
		expect(second.buildId).toBe(first.buildId);
	});

	it("should reuse the place when a baked mount has no source directory", async () => {
		expect.assertions(3);

		const { prepareAsync, volume } = setupBakedRun({ absent: "game.Workspace" });

		const first = await prepareAsync();

		const second = await prepareAsync();

		expect(second.rebuilt).toBeFalse();
		expect(second.buildId).toBe(first.buildId);
		expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe("rebuilt RBXL");
	});

	it("should clear an orphan mount directory of all but the baked stub", async () => {
		expect.assertions(4);

		const { prepareAsync, volume } = setupBakedRun({ absent: "game.Workspace" });
		await prepareAsync();

		// What an earlier run left in the mount the bake creates: a loose file
		// beside the stub and a directory under it, neither with a source twin
		// and neither the bake's.
		volume.mkdirSync(".jest-roblox/coverage/out/absent/stale", { recursive: true });
		volume.writeFileSync(".jest-roblox/coverage/out/absent/stale/old.luau", "local old = 1");
		volume.writeFileSync(".jest-roblox/coverage/out/absent/loose.luau", "local loose = 1");
		const second = await prepareAsync();

		// Sparing what the bake owns must not spare what sits beside it: a
		// stale file rojo would still mount is what the sweep exists for, and
		// the place has to be rebuilt around its absence.
		expect(volume.existsSync(absentStub)).toBeTrue();
		expect(volume.existsSync(".jest-roblox/coverage/out/absent/loose.luau")).toBeFalse();
		expect(volume.existsSync(".jest-roblox/coverage/out/absent/stale")).toBeFalse();
		expect(second.rebuilt).toBeTrue();
	});

	it("should rebuild when an empty leftover directory was all there was to sweep", async () => {
		expect.assertions(3);

		const { prepareAsync, volume } = setupBakedRun({ absent: "game.Workspace" });
		await prepareAsync();

		// Rojo mounts an empty directory as a Folder, so one left in the shadow
		// is a node in the place: a change the run has to report even though
		// no file went with it.
		volume.mkdirSync(".jest-roblox/coverage/out/absent/hollow", { recursive: true });
		const second = await prepareAsync();

		expect(second.rebuilt).toBeTrue();
		expect(volume.existsSync(".jest-roblox/coverage/out/absent/hollow")).toBeFalse();
		expect(volume.existsSync(absentStub)).toBeTrue();
	});

	it("should report no rebuild when a leftover directory cannot be removed", async () => {
		expect.assertions(2);

		const { fileSystem, prepareAsync, volume } = setupBakedRun({ absent: "game.Workspace" });
		await prepareAsync();

		const hollow = ".jest-roblox/coverage/out/absent/hollow";
		volume.mkdirSync(hollow, { recursive: true });
		vi.spyOn(fileSystem, "rmSync").mockImplementation(
			refuseRemovalOf(volume, "out/absent/hollow"),
		);
		const second = await prepareAsync();

		// An entry that survives the sweep is still in the place the last build
		// produced, so reporting it gone would rebuild over a lie.
		expect(second.rebuilt).toBeFalse();
		expect(volume.existsSync(hollow)).toBeTrue();
	});

	it("should keep a baked stub nested under an orphan directory", async () => {
		expect.assertions(3);

		const { prepareAsync, volume } = setupBakedRun({
			"absent/deep": "game.Workspace",
		});

		await prepareAsync();

		const second = await prepareAsync();

		expect(second.rebuilt).toBeFalse();
		expect(volume.readFileSync(".jest-roblox/place/game.rbxl", "utf8")).toBe("rebuilt RBXL");
		expect(
			volume.existsSync(".jest-roblox/coverage/out/absent/deep/jest.config.luau"),
		).toBeTrue();
	});

	it("should sweep an orphan mount directory on a rerun that does not bake", async () => {
		expect.assertions(2);

		const { childProcess, config, fileSystem, instrumenter, prepareAsync, volume } =
			setupBakedRun({ absent: "game.Workspace" });

		await prepareAsync();
		const hasBaked = volume.existsSync(absentStub);
		await prepareCoverageAsync(config, {
			childProcess,
			fileSystem,
			instrumenter,
			tsconfigReader: noTsconfig,
		});

		// The directory is as stale as the stub in it once nothing bakes, so
		// sparing owned files must not spare the ones nothing owns.
		expect(hasBaked).toBeTrue();
		expect(volume.existsSync(".jest-roblox/coverage/out/absent")).toBeFalse();
	});

	it("should sweep the stubs on a rerun that does not bake", async () => {
		expect.assertions(2);

		const { childProcess, config, fileSystem, instrumenter, prepareAsync, volume } =
			setupBakedRun();

		await prepareAsync();
		const hasBaked = volume.existsSync(sharedStub);
		await prepareCoverageAsync(config, {
			childProcess,
			fileSystem,
			instrumenter,
			tsconfigReader: noTsconfig,
		});

		// studio-cli's plugin materializes `jest.config` at runtime, so a stub
		// an earlier coverage run baked into the shared shadow would collide
		// with it.
		expect(hasBaked).toBeTrue();
		expect(volume.existsSync(sharedStub)).toBeFalse();
	});
});
