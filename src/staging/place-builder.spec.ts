import { PLACE_CONTENT_ID_NAME, PLACE_CONTENT_ID_SERVICE } from "@isentinel/roblox-runner";
import { fromAny } from "@total-typescript/shoehorn";

import { Buffer } from "node:buffer";
import * as path from "node:path";
import process from "node:process";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { ageFile } from "../../test/mocks/aged-file.ts";
import type { MemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { poolKeyOf, staged, stagedProjectSchema } from "../../test/mocks/staged-project.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { hashBuffer } from "../utils/hash.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { PINNED_MOUNT_PASS_VERSION } from "./pinned-mounts.ts";
import { buildPlaceAsync } from "./place-builder.ts";
import { computePlaceInputsKeyAsync } from "./place-reuse.ts";
import { relativizeProjectPaths } from "./relativize-paths.ts";
import { SHARED_POOL_PASS_VERSION } from "./shared-pool.ts";
import type { PackageDescriptor } from "./synthesizer.ts";
import { synthesize } from "./synthesizer.ts";

const PROJECT_FILE = "/cache/synth.project.json";
const PLACE_FILE = "/out/game.rbxl";
const PLACE_BYTES = "RBXL-BYTES";
const PACKAGE_DIR = "/pkg";
const PACKAGE_PROJECT = `${PACKAGE_DIR}/default.project.json`;
const MOUNT_DIR = "/repo/out";
const STAGE_DIR = "/repo/staged";
const NO_WRAP_PROJECT = JSON.stringify({ name: "synth", tree: { $path: MOUNT_DIR } });
const STAGED_PACKAGE_PROJECT = JSON.stringify({
	name: "synth",
	tree: { $className: "DataModel", Staged: { $className: "Folder", $path: STAGE_DIR } },
});
const STAND_IN_XML = [
	'<roblox version="4">',
	'  <Item class="StarterGui" referent="0">',
	"    <Properties>",
	'      <string name="Name">Gui</string>',
	"    </Properties>",
	"  </Item>",
	"</roblox>",
].join("\n");

type ExecCallback = (cause: Error | null, stdout: string, stderr: string) => void;
type RojoExec = (
	file: string,
	args: Array<string>,
	options: object,
	callback: ExecCallback,
) => void;

interface Harness extends MemoryFileSystem {
	childProcess: ChildProcessRunner;
	execFile: Mock<RojoExec>;
}

function seed(files: Record<string, string>, bytes: string = PLACE_BYTES): Harness {
	const memory = createMemoryFileSystem(files);
	const execFile = vi.fn<RojoExec>((_file, args, _options, callback) => {
		const outputPath = args[3];
		memory.volume.writeFileSync(String(outputPath), bytes);
		callback(null, "", "");
	});
	return { ...memory, childProcess: fromAny({ execFile }), execFile };
}

function writtenProject({ volume }: Harness): typeof stagedProjectSchema.infer {
	return stagedProjectSchema.assert(
		JSON.parse(String(volume.readFileSync(PROJECT_FILE, "utf8"))),
	);
}

function makeDescriptor(): PackageDescriptor {
	return {
		name: "pkg",
		packageDirectory: PACKAGE_DIR,
		rojoProjectPath: PACKAGE_PROJECT,
	};
}

function sharedDescriptor(name: string): PackageDescriptor {
	return {
		name,
		packageDirectory: `/pkg-${name}`,
		rojoProjectPath: `/pkg-${name}/default.project.json`,
	};
}

function seedSharedPackages(mounted: Record<string, string>, bytes?: string): Harness {
	return seed(
		{
			[sharedDescriptor("a").rojoProjectPath]: STAGED_PACKAGE_PROJECT,
			[sharedDescriptor("b").rojoProjectPath]: STAGED_PACKAGE_PROJECT,
			...mounted,
		},
		bytes,
	);
}

describe(buildPlaceAsync, () => {
	it("should return the built place path and its content hash", async () => {
		expect.assertions(1);

		const rojo = seed({ [PACKAGE_PROJECT]: NO_WRAP_PROJECT });

		const result = await buildPlaceAsync({
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		expect(result).toStrictEqual({
			hash: hashBuffer(Buffer.from(PLACE_BYTES)),
			path: PLACE_FILE,
		});
	});

	it("should stamp the content id into the place and record it on the artifact", async () => {
		expect.assertions(2);

		const rojo = seed({ [PACKAGE_PROJECT]: NO_WRAP_PROJECT });

		const result = await buildPlaceAsync({
			childProcess: rojo.childProcess,
			contentId: "deadbeef",
			fileSystem: rojo.fileSystem,
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		// Recorded on the artifact as well as stamped, because the host that
		// compares the two reads its half off the artifact.
		expect(writtenProject(rojo)).toMatchObject({
			tree: {
				[PLACE_CONTENT_ID_SERVICE]: {
					[PLACE_CONTENT_ID_NAME]: { $properties: { Value: "deadbeef" } },
				},
			},
		});
		expect(result.contentId).toBe("deadbeef");
	});

	it("should write the synthesized project to projectFile and build from it", async () => {
		expect.assertions(2);

		const rojo = seed({ [PACKAGE_PROJECT]: NO_WRAP_PROJECT });

		await buildPlaceAsync({
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		expect(writtenProject(rojo)).toMatchObject({ name: "synth" });
		expect(rojo.execFile).toHaveBeenCalledWith(
			"rojo",
			["build", PROJECT_FILE, "-o", PLACE_FILE],
			{ windowsHide: true },
			expect.any(Function),
		);
	});

	it("should write $path entries relative to the project file", async () => {
		expect.assertions(1);

		const rojo = seed({ [PACKAGE_PROJECT]: NO_WRAP_PROJECT });

		await buildPlaceAsync({
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		// Rojo matches globIgnorePaths against the path as written, so an
		// absolute mount would leave every ignore pattern inert.
		expect(writtenProject(rojo)).toMatchObject({
			tree: { $path: normalizeWindowsPath(path.relative("/cache", MOUNT_DIR)) },
		});
	});

	it("should forward wrap and loadStringEnabled to synthesize", async () => {
		expect.assertions(2);

		const rojo = seed({ [PACKAGE_PROJECT]: NO_WRAP_PROJECT });

		await buildPlaceAsync({
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			loadStringEnabled: true,
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		const project = writtenProject(rojo);

		expect(project).toMatchObject({
			tree: { ServerScriptService: { $properties: { LoadStringEnabled: true } } },
		});
		expect(project.tree).not.toHaveProperty("ServerStorage");
	});

	it("should create the place file's parent directory before building", async () => {
		expect.assertions(1);

		const rojo = seed({ [PACKAGE_PROJECT]: NO_WRAP_PROJECT });

		await buildPlaceAsync({
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			packages: [makeDescriptor()],
			placeFile: "/fresh/nested/game.rbxl",
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		expect(rojo.volume.existsSync("/fresh/nested/game.rbxl")).toBeTrue();
	});

	it("should build a mount two packages share once, under the shared pool", async () => {
		expect.assertions(3);

		const rojo = seedSharedPackages({ [`${STAGE_DIR}/shared.luau`]: "return {}" });

		await buildPlaceAsync({
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			packages: [sharedDescriptor("a"), sharedDescriptor("b")],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
		});

		const project = writtenProject(rojo);
		const keys = Object.keys(staged(project, "__shared")!).filter(
			(key) => key !== "$className",
		);

		expect(keys).toHaveLength(1);
		expect(poolKeyOf(staged(project, "a", "Staged"))).toBe(keys[0]!);
		expect(poolKeyOf(staged(project, "b", "Staged"))).toBe(keys[0]!);
	});

	it("should demote a pinned mount two packages share for both of them", async () => {
		expect.assertions(1);

		// The pool runs first, so the pinned-mount pass meets one node rather
		// than two and its single stand-in reaches every package. Running it
		// second, the pass skips the repeat as already scanned and leaves the
		// second package mounting the model the engine rejects.
		const rojo = seedSharedPackages(
			{ [`${STAGE_DIR}/Gui.model.json`]: JSON.stringify({ ClassName: "StarterGui" }) },
			STAND_IN_XML,
		);

		await buildPlaceAsync({
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			packages: [sharedDescriptor("a"), sharedDescriptor("b")],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
		});

		const pool = staged(writtenProject(rojo), "__shared");

		expect(JSON.stringify(pool)).toContain("pinned-shadow");
	});
});

const CACHE_FILE = "/cache/place-cache.json";
const DIGEST_CACHE_FILE = "/cache/input-digests";

describe("place reuse", () => {
	function seedBuild(): Harness {
		const rojo = seed({
			[`${MOUNT_DIR}/init.luau`]: "print('hi')",
			[PACKAGE_PROJECT]: NO_WRAP_PROJECT,
		});
		// Back-dated so the digest cache is allowed to record a digest for it.
		ageFile(rojo.fileSystem, `${MOUNT_DIR}/init.luau`, 60);
		return rojo;
	}

	async function buildAsync(rojo: Harness, wrap = false): ReturnType<typeof buildPlaceAsync> {
		return buildPlaceAsync({
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			reuse: {
				cacheFile: CACHE_FILE,
				digestCacheFile: DIGEST_CACHE_FILE,
				manifests: [],
				shadowRoots: [],
			},
			wrap,
		});
	}

	it("should not re-read an unchanged mount to decide on reuse", async () => {
		expect.assertions(1);

		const rojo = seedBuild();
		await buildAsync(rojo);

		const readFile = vi.spyOn(rojo.fileSystem.promises, "readFile");
		await buildAsync(rojo);

		expect(readFile).not.toHaveBeenCalledWith(`${MOUNT_DIR}/init.luau`);
	});

	it("should skip the rojo build when nothing changed", async () => {
		expect.assertions(3);

		const rojo = seedBuild();
		const first = await buildAsync(rojo);

		expect(rojo.execFile).toHaveBeenCalledOnce();

		const second = await buildAsync(rojo);

		expect(rojo.execFile).toHaveBeenCalledOnce();
		expect(second).toStrictEqual(first);
	});

	it("should rebuild when a mounted input changed", async () => {
		expect.assertions(1);

		const rojo = seedBuild();
		await buildAsync(rojo);
		rojo.volume.writeFileSync(`${MOUNT_DIR}/init.luau`, "print('edited')");
		await buildAsync(rojo);

		expect(rojo.execFile).toHaveBeenCalledTimes(2);
	});

	it("should rebuild when the place file is gone", async () => {
		expect.assertions(1);

		const rojo = seedBuild();
		await buildAsync(rojo);
		rojo.volume.unlinkSync(PLACE_FILE);
		await buildAsync(rojo);

		expect(rojo.execFile).toHaveBeenCalledTimes(2);
	});

	it("should rebuild when the place no longer matches its recorded hash", async () => {
		expect.assertions(1);

		const rojo = seedBuild();
		await buildAsync(rojo);
		// What an interrupted rojo build leaves: a place on disk that the
		// still-current record no longer describes.
		rojo.volume.writeFileSync(PLACE_FILE, "TRUNCATED");
		await buildAsync(rojo);

		expect(rojo.execFile).toHaveBeenCalledTimes(2);
	});

	it("should rebuild when the inputs cannot be hashed", async () => {
		expect.assertions(2);

		const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const rojo = seed({
			[PACKAGE_PROJECT]: JSON.stringify({
				name: "synth",
				servePort: 1.5,
				tree: { $path: MOUNT_DIR },
			}),
		});

		await buildAsync(rojo);
		await buildAsync(rojo);

		expect(write.mock.calls.map(String).join("")).toContain("could not hash rojo build inputs");
		expect(rojo.execFile).toHaveBeenCalledTimes(2);
	});

	it("should skip the pinned-mount pass when nothing changed", async () => {
		expect.assertions(2);

		// A staged mount carrying a class the engine pins: the pinned-mount
		// pass spawns rojo once to build its Folder-rooted stand-in, on top of
		// the one spawn the place itself costs.
		const rojo = seed(
			{
				[`${STAGE_DIR}/Gui.model.json`]: JSON.stringify({ ClassName: "StarterGui" }),
				[PACKAGE_PROJECT]: STAGED_PACKAGE_PROJECT,
			},
			STAND_IN_XML,
		);

		await buildAsync(rojo, true);

		expect(rojo.execFile).toHaveBeenCalledTimes(2);

		await buildAsync(rojo, true);

		expect(rojo.execFile).toHaveBeenCalledTimes(2);
	});

	it("should fold the shared-pool pass version into the key", async () => {
		expect.assertions(2);

		const rojo = seedBuild();
		await buildAsync(rojo);
		const recorded = JSON.parse(String(rojo.volume.readFileSync(CACHE_FILE, "utf8")));
		const projectJson = synthesize({
			fileSystem: rojo.fileSystem,
			packages: [makeDescriptor()],
			wrap: false,
		});

		// The build's own inputs, keyed over a chosen set of passes. A pool
		// pass left out of the key would hand out a place built by its
		// previous rule.
		async function keyOverAsync(stagingVersions: Array<number>): Promise<string | undefined> {
			return computePlaceInputsKeyAsync({
				digestCacheFile: DIGEST_CACHE_FILE,
				fileSystem: rojo.fileSystem,
				manifests: [],
				projectFile: PROJECT_FILE,
				projectJson: relativizeProjectPaths(projectJson, path.dirname(PROJECT_FILE)),
				shadowRoots: [],
				stagingVersions,
			});
		}

		expect(recorded).not.toMatchObject({
			inputsKey: await keyOverAsync([PINNED_MOUNT_PASS_VERSION]),
		});
		expect(recorded).toMatchObject({
			inputsKey: await keyOverAsync([PINNED_MOUNT_PASS_VERSION, SHARED_POOL_PASS_VERSION]),
		});
	});

	it("should build every time when no reuse cache is configured", async () => {
		expect.assertions(1);

		const rojo = seedBuild();
		const options = {
			childProcess: rojo.childProcess,
			fileSystem: rojo.fileSystem,
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		};
		await buildPlaceAsync(options);
		await buildPlaceAsync(options);

		expect(rojo.execFile).toHaveBeenCalledTimes(2);
	});
});
