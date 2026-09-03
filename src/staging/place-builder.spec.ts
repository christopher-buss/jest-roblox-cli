import { fromAny } from "@total-typescript/shoehorn";

import { type } from "arktype";
import { vol } from "memfs";
import { Buffer } from "node:buffer";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { ageFile } from "../../test/mocks/aged-file.ts";
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

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

vi.mock(import("./synthesizer"));
vi.mock(import("../utils/rojo-builder"));

const PROJECT_FILE = "/cache/synth.project.json";
const PLACE_FILE = "/out/game.rbxl";
const PLACE_BYTES = "RBXL-BYTES";
const MOUNT_DIR = "/repo/out";
const PROJECT_JSON = JSON.stringify({ name: "synth", tree: { $path: MOUNT_DIR } });
const STAGE_DIR = "/repo/staged";
const STAGED_PROJECT_JSON = JSON.stringify({
	name: "synth",
	tree: {
		$className: "DataModel",
		ServerStorage: { $className: "ServerStorage", __pkg_stage: { $path: STAGE_DIR } },
	},
});
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
const SHARED_PROJECT_JSON = JSON.stringify({
	name: "synth",
	tree: {
		$className: "DataModel",
		ServerStorage: {
			$className: "ServerStorage",
			__pkg_stage: {
				a: { $className: "Folder", Shared: { $className: "Folder", $path: STAGE_DIR } },
				b: { $className: "Folder", Shared: { $className: "Folder", $path: STAGE_DIR } },
			},
		},
	},
});

const markerSchema = type({ Shared: { $attributes: { JestSharedPoolKey: "string" } } });
const pooledProjectSchema = type({
	tree: {
		ServerStorage: {
			__pkg_stage: { __shared: { "[string]": "unknown" }, a: markerSchema, b: markerSchema },
		},
	},
});

function readPooledProject(): typeof pooledProjectSchema.infer {
	return pooledProjectSchema.assert(JSON.parse(String(vol.readFileSync(PROJECT_FILE, "utf8"))));
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

		onTestFinished(() => {
			vol.reset();
		});

		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			// No mkdir here: buildPlaceAsync creates the output directory before
			// building.
			vol.writeFileSync(outputPath, PLACE_BYTES);
		});

		const result = await buildPlaceAsync({
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

		onTestFinished(() => {
			vol.reset();
		});

		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			vol.writeFileSync(outputPath, PLACE_BYTES);
		});

		const result = await buildPlaceAsync({
			contentId: "deadbeef",
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

		onTestFinished(() => {
			vol.reset();
		});

		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			// No mkdir here: buildPlaceAsync creates the output directory before
			// building.
			vol.writeFileSync(outputPath, PLACE_BYTES);
		});

		await buildPlaceAsync({
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		expect(JSON.parse(String(vol.readFileSync(PROJECT_FILE, "utf8")))).toMatchObject({
			name: "synth",
		});
		expect(buildWithRojoAsync).toHaveBeenCalledWith(PROJECT_FILE, PLACE_FILE);
	});

	it("should write $path entries relative to the project file", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			vol.writeFileSync(outputPath, PLACE_BYTES);
		});

		await buildPlaceAsync({
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		// Rojo matches globIgnorePaths against the path as written, so an
		// absolute mount would leave every ignore pattern inert.
		expect(JSON.parse(String(vol.readFileSync(PROJECT_FILE, "utf8")))).toMatchObject({
			tree: { $path: normalizeWindowsPath(path.relative("/cache", MOUNT_DIR)) },
		});
	});

	it("should forward wrap and loadStringEnabled to synthesize", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			vol.writeFileSync(outputPath, PLACE_BYTES);
		});

		const packages = [makeDescriptor()];
		await buildPlaceAsync({
			loadStringEnabled: true,
			packages,
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		expect(synthesize).toHaveBeenCalledWith({ loadStringEnabled: true, packages, wrap: false });
	});

	it("should create the place file's parent directory before building", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		// Writes straight to the output path with no mkdir — succeeds only
		// because buildPlaceAsync created the (nested, not-yet-existing)
		// directory.
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			vol.writeFileSync(outputPath, PLACE_BYTES);
		});

		await buildPlaceAsync({
			packages: [makeDescriptor()],
			placeFile: "/fresh/nested/game.rbxl",
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		expect(vol.existsSync("/fresh/nested/game.rbxl")).toBeTrue();
	});

	it("should build a mount two packages share once, under the shared pool", async () => {
		expect.assertions(3);

		onTestFinished(() => {
			vol.reset();
		});

		vi.mocked(synthesize).mockReturnValue(SHARED_PROJECT_JSON);
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			vol.writeFileSync(outputPath, PLACE_BYTES);
		});
		vol.fromJSON({ [`${STAGE_DIR}/shared.luau`]: "return {}" });

		await buildPlaceAsync({
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
		});

		const stage = readPooledProject().tree.ServerStorage.__pkg_stage;
		const keys = Object.keys(stage.__shared).filter((key) => key !== "$className");

		expect(keys).toHaveLength(1);
		expect(stage.a.Shared.$attributes.JestSharedPoolKey).toBe(keys[0]!);
		expect(stage.b.Shared.$attributes.JestSharedPoolKey).toBe(keys[0]!);
	});

	it("should demote a pinned mount two packages share for both of them", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		// The pool runs first, so the pinned-mount pass meets one node rather
		// than two and its single stand-in reaches every package. Running it
		// second, the pass skips the repeat as already scanned and leaves the
		// second package mounting the model the engine rejects.
		vi.mocked(synthesize).mockReturnValue(SHARED_PROJECT_JSON);
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			vol.writeFileSync(outputPath, STAND_IN_XML);
		});
		vol.fromJSON({
			[`${STAGE_DIR}/Gui.model.json`]: JSON.stringify({ ClassName: "StarterGui" }),
		});

		await buildPlaceAsync({
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
		});

		const pool = readPooledProject().tree.ServerStorage.__pkg_stage.__shared;

		expect(JSON.stringify(pool)).toContain("pinned-shadow");
	});
});

const CACHE_FILE = "/cache/place-cache.json";
const DIGEST_CACHE_FILE = "/cache/input-digests";

describe("place reuse", () => {
	function seedBuild(): void {
		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			vol.writeFileSync(outputPath, PLACE_BYTES);
		});
		vol.fromJSON({ [`${MOUNT_DIR}/init.luau`]: "print('hi')" });
		// Back-dated so the digest cache is allowed to record a digest for it.
		ageFile(`${MOUNT_DIR}/init.luau`, 60);
	}

	async function buildAsync(): ReturnType<typeof buildPlaceAsync> {
		return buildPlaceAsync({
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

		onTestFinished(() => {
			vol.reset();
		});

		seedBuild();
		await buildAsync();

		const readFile = vi.spyOn(nodeFs.promises, "readFile");
		await buildAsync();

		expect(readFile).not.toHaveBeenCalledWith(`${MOUNT_DIR}/init.luau`);
	});

	it("should skip the rojo buildAsync when nothing changed", async () => {
		expect.assertions(3);

		onTestFinished(() => {
			vol.reset();
		});

		seedBuild();
		const first = await buildAsync();

		expect(vi.mocked(buildWithRojoAsync)).toHaveBeenCalledOnce();

		const second = await buildAsync();

		expect(vi.mocked(buildWithRojoAsync)).toHaveBeenCalledOnce();
		expect(second).toStrictEqual(first);
	});

	it("should rebuild when a mounted input changed", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		seedBuild();
		await buildAsync();
		vol.writeFileSync(`${MOUNT_DIR}/init.luau`, "print('edited')");
		await buildAsync();

		expect(vi.mocked(buildWithRojoAsync)).toHaveBeenCalledTimes(2);
	});

	it("should rebuild when the place file is gone", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		seedBuild();
		await buildAsync();
		vol.unlinkSync(PLACE_FILE);
		await buildAsync();

		expect(vi.mocked(buildWithRojoAsync)).toHaveBeenCalledTimes(2);
	});

	it("should rebuild when the place no longer matches its recorded hash", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		seedBuild();
		await buildAsync();
		// What an interrupted rojo buildAsync leaves: a place on disk that the
		// still-current record no longer describes.
		vol.writeFileSync(PLACE_FILE, "TRUNCATED");
		await buildAsync();

		expect(vi.mocked(buildWithRojoAsync)).toHaveBeenCalledTimes(2);
	});

	it("should rebuild when the inputs cannot be hashed", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		// Valid JSON, but no `tree` — the shape the inputs hash rejects. The
		// buildAsync itself is mocked, so only the reuse decision is under test.
		vi.mocked(synthesize).mockReturnValue(String.raw`{"name":"synth"}`);
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			vol.writeFileSync(outputPath, PLACE_BYTES);
		});

		await buildAsync();
		await buildAsync();

		expect(vi.mocked(buildWithRojoAsync)).toHaveBeenCalledTimes(2);
	});

	it("should skip the pinned-mount pass when nothing changed", async () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		// A staged mount carrying a class the engine pins: the pinned-mount
		// pass spawns rojo once to buildAsync its Folder-rooted stand-in, on top
		// of the one spawn the place itself costs.
		vi.mocked(synthesize).mockReturnValue(STAGED_PROJECT_JSON);
		// The same bytes for both outputs: only the stand-in is read back, and
		// nothing here parses the place.
		vi.mocked(buildWithRojoAsync).mockImplementation(async (_projectPath, outputPath) => {
			vol.writeFileSync(outputPath, STAND_IN_XML);
		});
		vol.fromJSON({
			[`${STAGE_DIR}/Gui.model.json`]: JSON.stringify({ ClassName: "StarterGui" }),
		});

		await buildAsync();

		expect(vi.mocked(buildWithRojoAsync)).toHaveBeenCalledTimes(2);

		await buildAsync();

		expect(vi.mocked(buildWithRojoAsync)).toHaveBeenCalledTimes(2);
	});

	it("should fold the shared-pool pass version into the key", async () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		seedBuild();
		await buildAsync();
		const recorded = JSON.parse(String(vol.readFileSync(CACHE_FILE, "utf8")));

		// The build's own inputs, keyed over a chosen set of passes. A pool
		// pass left out of the key would hand out a place built by its
		// previous rule.
		async function keyOverAsync(stagingVersions: Array<number>): Promise<string | undefined> {
			return computePlaceInputsKeyAsync({
				digestCacheFile: DIGEST_CACHE_FILE,
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

		onTestFinished(() => {
			vol.reset();
		});

		seedBuild();
		const options = {
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
		};
		await buildPlaceAsync(options);
		await buildPlaceAsync(options);

		expect(vi.mocked(buildWithRojoAsync)).toHaveBeenCalledTimes(2);
	});
});
