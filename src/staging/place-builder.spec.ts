import { Buffer } from "node:buffer";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { ageFile } from "../../test/mocks/aged-file.ts";
import type { MemoryFileSystem, MemoryVolume } from "../../test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import {
	poolKeyOf,
	staged,
	stagedProject,
	stagedProjectSchema,
} from "../../test/mocks/staged-project.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { hashBuffer } from "../utils/hash.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { buildWithRojoAsync } from "../utils/rojo-builder.ts";
import { PINNED_MOUNT_PASS_VERSION } from "./pinned-mounts.ts";
import { buildPlaceAsync } from "./place-builder.ts";
import { computePlaceInputsKeyAsync } from "./place-reuse.ts";
import { relativizeProjectPaths } from "./relativize-paths.ts";
import { SHARED_POOL_PASS_VERSION } from "./shared-pool.ts";
import type { PackageDescriptor } from "./synthesizer.ts";
import { synthesize } from "./synthesizer.ts";

vi.mock(import("./synthesizer"));
vi.mock(import("../utils/rojo-builder"));

const PROJECT_FILE = "/cache/synth.project.json";
const PLACE_FILE = "/out/game.rbxl";
const PLACE_BYTES = "RBXL-BYTES";
const MOUNT_DIR = "/repo/out";
const PROJECT_JSON = JSON.stringify({ name: "synth", tree: { $path: MOUNT_DIR } });
const STAGE_DIR = "/repo/staged";
const STAGED_PROJECT_JSON = stagedProject({ $path: STAGE_DIR });
/** What `rojo buildAsync` emits for the pinned mount, before the class fold. */
const STAND_IN_XML = [
	'<roblox version="4">',
	'  <Item class="StarterGui" referent="0">',
	"    <Properties>",
	'      <string name="Name">Gui</string>',
	"    </Properties>",
	"  </Item>",
	"</roblox>",
].join("\n");

/** Two packages mounting one directory — what the shared pool exists for. */
const SHARED_PROJECT_JSON = stagedProject({
	a: { $className: "Folder", Shared: { $className: "Folder", $path: STAGE_DIR } },
	b: { $className: "Folder", Shared: { $className: "Folder", $path: STAGE_DIR } },
});

/**
 * The project the pooling pass wrote back.
 *
 * @param volume - The volume the build staged into.
 */
function readPooledProject(volume: MemoryVolume): typeof stagedProjectSchema.infer {
	return stagedProjectSchema.assert(
		JSON.parse(String(volume.readFileSync(PROJECT_FILE, "utf8"))),
	);
}

function makeDescriptor(): PackageDescriptor {
	return {
		name: "pkg",
		packageDirectory: "/pkg",
		rojoProjectPath: "/pkg/default.project.json",
	};
}

describe(buildPlaceAsync, () => {
	it("should return the built place path and its content hash", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			// No mkdir here: buildPlaceAsync creates the output directory before
			// building.
			volume.writeFileSync(outputPath, PLACE_BYTES);
		});

		const result = await buildPlaceAsync({
			fileSystem,
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

		const { fileSystem, volume } = createMemoryFileSystem();

		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			volume.writeFileSync(outputPath, PLACE_BYTES);
		});

		const result = await buildPlaceAsync({
			contentId: "deadbeef",
			fileSystem,
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		// Recorded on the artifact as well as stamped, because the host that
		// compares the two reads its half off the artifact.
		expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({ contentId: "deadbeef" }));
		expect(result.contentId).toBe("deadbeef");
	});

	it("should write the synthesized project to projectFile and buildAsync from it", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			// No mkdir here: buildPlaceAsync creates the output directory before
			// building.
			volume.writeFileSync(outputPath, PLACE_BYTES);
		});

		await buildPlaceAsync({
			fileSystem,
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		expect(JSON.parse(String(volume.readFileSync(PROJECT_FILE, "utf8")))).toMatchObject({
			name: "synth",
		});
		expect(buildWithRojoAsync).toHaveBeenCalledWith(PROJECT_FILE, PLACE_FILE);
	});

	it("should write $path entries relative to the project file", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			volume.writeFileSync(outputPath, PLACE_BYTES);
		});

		await buildPlaceAsync({
			fileSystem,
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		// Rojo matches globIgnorePaths against the path as written, so an
		// absolute mount would leave every ignore pattern inert.
		expect(JSON.parse(String(volume.readFileSync(PROJECT_FILE, "utf8")))).toMatchObject({
			tree: { $path: normalizeWindowsPath(path.relative("/cache", MOUNT_DIR)) },
		});
	});

	it("should forward wrap and loadStringEnabled to synthesize", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			volume.writeFileSync(outputPath, PLACE_BYTES);
		});

		const packages = [makeDescriptor()];
		await buildPlaceAsync({
			fileSystem,
			loadStringEnabled: true,
			packages,
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		expect(synthesize).toHaveBeenCalledWith({
			fileSystem,
			loadStringEnabled: true,
			packages,
			wrap: false,
		});
	});

	it("should create the place file's parent directory before building", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		// Writes straight to the output path with no mkdir — succeeds only
		// because buildPlaceAsync created the (nested, not-yet-existing)
		// directory.
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			volume.writeFileSync(outputPath, PLACE_BYTES);
		});

		await buildPlaceAsync({
			fileSystem,
			packages: [makeDescriptor()],
			placeFile: "/fresh/nested/game.rbxl",
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		expect(volume.existsSync("/fresh/nested/game.rbxl")).toBeTrue();
	});

	it("should build a mount two packages share once, under the shared pool", async () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();

		vi.mocked(synthesize).mockReturnValue(SHARED_PROJECT_JSON);
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			volume.writeFileSync(outputPath, PLACE_BYTES);
		});
		volume.fromJSON({ [`${STAGE_DIR}/shared.luau`]: "return {}" });

		await buildPlaceAsync({
			fileSystem,
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
		});

		const project = readPooledProject(volume);
		const keys = Object.keys(staged(project, "__shared")!).filter(
			(key) => key !== "$className",
		);

		expect(keys).toHaveLength(1);
		expect(poolKeyOf(staged(project, "a", "Shared"))).toBe(keys[0]!);
		expect(poolKeyOf(staged(project, "b", "Shared"))).toBe(keys[0]!);
	});

	it("should demote a pinned mount two packages share for both of them", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		// The pool runs first, so the pinned-mount pass meets one node rather
		// than two and its single stand-in reaches every package. Running it
		// second, the pass skips the repeat as already scanned and leaves the
		// second package mounting the model the engine rejects.
		vi.mocked(synthesize).mockReturnValue(SHARED_PROJECT_JSON);
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			volume.writeFileSync(outputPath, STAND_IN_XML);
		});
		volume.fromJSON({
			[`${STAGE_DIR}/Gui.model.json`]: JSON.stringify({ ClassName: "StarterGui" }),
		});

		await buildPlaceAsync({
			fileSystem,
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
		});

		const pool = staged(readPooledProject(volume), "__shared");

		expect(JSON.stringify(pool)).toContain("pinned-shadow");
	});
});

const CACHE_FILE = "/cache/place-cache.json";
const DIGEST_CACHE_FILE = "/cache/input-digests";

describe("place reuse", () => {
	function seedBuild(): MemoryFileSystem {
		const memory = createMemoryFileSystem({ [`${MOUNT_DIR}/init.luau`]: "print('hi')" });
		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			memory.volume.writeFileSync(outputPath, PLACE_BYTES);
		});
		// Back-dated so the digest cache is allowed to record a digest for it.
		ageFile(memory.fileSystem, `${MOUNT_DIR}/init.luau`, 60);
		return memory;
	}

	async function buildAsync(fileSystem: FileSystem): ReturnType<typeof buildPlaceAsync> {
		return buildPlaceAsync({
			fileSystem,
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			reuse: {
				cacheFile: CACHE_FILE,
				digestCacheFile: DIGEST_CACHE_FILE,
				manifests: [],
				shadowRoots: [],
			},
		});
	}

	it("should not re-read an unchanged mount to decide on reuse", async () => {
		expect.assertions(1);

		const { fileSystem } = seedBuild();
		await buildAsync(fileSystem);

		const readFile = vi.spyOn(fileSystem.promises, "readFile");
		await buildAsync(fileSystem);

		expect(readFile).not.toHaveBeenCalledWith(`${MOUNT_DIR}/init.luau`);
	});

	it("should skip the rojo buildAsync when nothing changed", async () => {
		expect.assertions(3);

		const { fileSystem } = seedBuild();
		const first = await buildAsync(fileSystem);

		expect(vi.mocked(buildWithRojoAsync)).toHaveBeenCalledOnce();

		const second = await buildAsync(fileSystem);

		expect(vi.mocked(buildWithRojoAsync)).toHaveBeenCalledOnce();
		expect(second).toStrictEqual(first);
	});

	it("should rebuild when a mounted input changed", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = seedBuild();
		await buildAsync(fileSystem);
		volume.writeFileSync(`${MOUNT_DIR}/init.luau`, "print('edited')");
		await buildAsync(fileSystem);

		expect(vi.mocked(buildWithRojoAsync)).toHaveBeenCalledTimes(2);
	});

	it("should rebuild when the place file is gone", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = seedBuild();
		await buildAsync(fileSystem);
		volume.unlinkSync(PLACE_FILE);
		await buildAsync(fileSystem);

		expect(vi.mocked(buildWithRojoAsync)).toHaveBeenCalledTimes(2);
	});

	it("should rebuild when the place no longer matches its recorded hash", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = seedBuild();
		await buildAsync(fileSystem);
		// What an interrupted rojo buildAsync leaves: a place on disk that the
		// still-current record no longer describes.
		volume.writeFileSync(PLACE_FILE, "TRUNCATED");
		await buildAsync(fileSystem);

		expect(vi.mocked(buildWithRojoAsync)).toHaveBeenCalledTimes(2);
	});

	it("should rebuild when the inputs cannot be hashed", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		// Valid JSON, but no `tree` — the shape the inputs hash rejects. The
		// buildAsync itself is mocked, so only the reuse decision is under test.
		vi.mocked(synthesize).mockReturnValue(String.raw`{"name":"synth"}`);
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			volume.writeFileSync(outputPath, PLACE_BYTES);
		});

		await buildAsync(fileSystem);
		await buildAsync(fileSystem);

		expect(vi.mocked(buildWithRojoAsync)).toHaveBeenCalledTimes(2);
	});

	it("should skip the pinned-mount pass when nothing changed", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		// A staged mount carrying a class the engine pins: the pinned-mount
		// pass spawns rojo once to buildAsync its Folder-rooted stand-in, on top
		// of the one spawn the place itself costs.
		vi.mocked(synthesize).mockReturnValue(STAGED_PROJECT_JSON);
		// The same bytes for both outputs: only the stand-in is read back, and
		// nothing here parses the place.
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			volume.writeFileSync(outputPath, STAND_IN_XML);
		});
		volume.fromJSON({
			[`${STAGE_DIR}/Gui.model.json`]: JSON.stringify({ ClassName: "StarterGui" }),
		});

		await buildAsync(fileSystem);

		expect(vi.mocked(buildWithRojoAsync)).toHaveBeenCalledTimes(2);

		await buildAsync(fileSystem);

		expect(vi.mocked(buildWithRojoAsync)).toHaveBeenCalledTimes(2);
	});

	it("should fold the shared-pool pass version into the key", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = seedBuild();
		await buildAsync(fileSystem);
		const recorded = JSON.parse(String(volume.readFileSync(CACHE_FILE, "utf8")));

		// The build's own inputs, keyed over a chosen set of passes. A pool
		// pass left out of the key would hand out a place built by its
		// previous rule.
		async function keyOverAsync(stagingVersions: Array<number>): Promise<string | undefined> {
			return computePlaceInputsKeyAsync({
				digestCacheFile: DIGEST_CACHE_FILE,
				fileSystem,
				manifests: [],
				projectFile: PROJECT_FILE,
				projectJson: relativizeProjectPaths(PROJECT_JSON, path.dirname(PROJECT_FILE)),
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

	it("should buildAsync every time when no reuse cache is configured", async () => {
		expect.assertions(1);

		const { fileSystem } = seedBuild();
		const options = {
			fileSystem,
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
		};
		await buildPlaceAsync(options);
		await buildPlaceAsync(options);

		expect(vi.mocked(buildWithRojoAsync)).toHaveBeenCalledTimes(2);
	});
});
