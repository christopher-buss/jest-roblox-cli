import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import { Buffer } from "node:buffer";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { hashBuffer } from "../utils/hash.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { buildWithRojo } from "../utils/rojo-builder.ts";
import { buildPlace } from "./place-builder.ts";
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
/** What `rojo build` emits for the pinned mount, before the class fold. */
const STAND_IN_XML = [
	'<roblox version="4">',
	'  <Item class="StarterGui" referent="0">',
	"    <Properties>",
	'      <string name="Name">Gui</string>',
	"    </Properties>",
	"  </Item>",
	"</roblox>",
].join("\n");

function makeDescriptor(): PackageDescriptor {
	return {
		name: "pkg",
		packageDirectory: "/pkg",
		rojoProjectPath: "/pkg/default.project.json",
	};
}

describe(buildPlace, () => {
	it("should return the built place path and its content hash", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		vi.mocked(buildWithRojo).mockImplementation((_projectPath, outputPath) => {
			// No mkdir here: buildPlace creates the output directory before
			// building.
			vol.writeFileSync(outputPath, PLACE_BYTES);
		});

		const result = buildPlace({
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

	it("should write the synthesized project to projectFile and build from it", () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		vi.mocked(buildWithRojo).mockImplementation((_projectPath, outputPath) => {
			// No mkdir here: buildPlace creates the output directory before
			// building.
			vol.writeFileSync(outputPath, PLACE_BYTES);
		});

		buildPlace({
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		expect(JSON.parse(String(vol.readFileSync(PROJECT_FILE, "utf8")))).toMatchObject({
			name: "synth",
		});
		expect(buildWithRojo).toHaveBeenCalledWith(PROJECT_FILE, PLACE_FILE);
	});

	it("should write $path entries relative to the project file", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		vi.mocked(buildWithRojo).mockImplementation((_projectPath, outputPath) => {
			vol.writeFileSync(outputPath, PLACE_BYTES);
		});

		buildPlace({
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

	it("should forward wrap and loadStringEnabled to synthesize", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		vi.mocked(buildWithRojo).mockImplementation((_projectPath, outputPath) => {
			vol.writeFileSync(outputPath, PLACE_BYTES);
		});

		const packages = [makeDescriptor()];
		buildPlace({
			loadStringEnabled: true,
			packages,
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		expect(synthesize).toHaveBeenCalledWith({ loadStringEnabled: true, packages, wrap: false });
	});

	it("should create the place file's parent directory before building", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		// Writes straight to the output path with no mkdir — succeeds only
		// because buildPlace created the (nested, not-yet-existing) directory.
		vi.mocked(buildWithRojo).mockImplementation((_projectPath, outputPath) => {
			vol.writeFileSync(outputPath, PLACE_BYTES);
		});

		buildPlace({
			packages: [makeDescriptor()],
			placeFile: "/fresh/nested/game.rbxl",
			projectFile: PROJECT_FILE,
			wrap: false,
		});

		expect(vol.existsSync("/fresh/nested/game.rbxl")).toBeTrue();
	});
});

const CACHE_FILE = "/cache/place-cache.json";

describe("place reuse", () => {
	function seedBuild(): void {
		vi.mocked(synthesize).mockReturnValue(PROJECT_JSON);
		vi.mocked(buildWithRojo).mockImplementation((_projectPath, outputPath) => {
			vol.writeFileSync(outputPath, PLACE_BYTES);
		});
		vol.fromJSON({ [`${MOUNT_DIR}/init.luau`]: "print('hi')" });
	}

	function build(): ReturnType<typeof buildPlace> {
		return buildPlace({
			packages: [makeDescriptor()],
			placeFile: PLACE_FILE,
			projectFile: PROJECT_FILE,
			reuse: { cacheFile: CACHE_FILE, manifests: [], shadowRoots: [] },
		});
	}

	it("should skip the rojo build when nothing changed", () => {
		expect.assertions(3);

		onTestFinished(() => {
			vol.reset();
		});

		seedBuild();
		const first = build();

		expect(vi.mocked(buildWithRojo)).toHaveBeenCalledOnce();

		const second = build();

		expect(vi.mocked(buildWithRojo)).toHaveBeenCalledOnce();
		expect(second).toStrictEqual(first);
	});

	it("should rebuild when a mounted input changed", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		seedBuild();
		build();
		vol.writeFileSync(`${MOUNT_DIR}/init.luau`, "print('edited')");
		build();

		expect(vi.mocked(buildWithRojo)).toHaveBeenCalledTimes(2);
	});

	it("should rebuild when the place file is gone", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		seedBuild();
		build();
		vol.unlinkSync(PLACE_FILE);
		build();

		expect(vi.mocked(buildWithRojo)).toHaveBeenCalledTimes(2);
	});

	it("should rebuild when the place no longer matches its recorded hash", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		seedBuild();
		build();
		// What an interrupted rojo build leaves: a place on disk that the
		// still-current record no longer describes.
		vol.writeFileSync(PLACE_FILE, "TRUNCATED");
		build();

		expect(vi.mocked(buildWithRojo)).toHaveBeenCalledTimes(2);
	});

	it("should rebuild when the inputs cannot be hashed", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		// Valid JSON, but no `tree` — the shape the inputs hash rejects. The
		// build itself is mocked, so only the reuse decision is under test.
		vi.mocked(synthesize).mockReturnValue(String.raw`{"name":"synth"}`);
		vi.mocked(buildWithRojo).mockImplementation((_projectPath, outputPath) => {
			vol.writeFileSync(outputPath, PLACE_BYTES);
		});

		build();
		build();

		expect(vi.mocked(buildWithRojo)).toHaveBeenCalledTimes(2);
	});

	it("should skip the pinned-mount pass when nothing changed", () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		// A staged mount carrying a class the engine pins: the pinned-mount
		// pass spawns rojo once to build its Folder-rooted stand-in, on top of
		// the one spawn the place itself costs.
		vi.mocked(synthesize).mockReturnValue(STAGED_PROJECT_JSON);
		// The same bytes for both outputs: only the stand-in is read back, and
		// nothing here parses the place.
		vi.mocked(buildWithRojo).mockImplementation((_projectPath, outputPath) => {
			vol.writeFileSync(outputPath, STAND_IN_XML);
		});
		vol.fromJSON({
			[`${STAGE_DIR}/Gui.model.json`]: JSON.stringify({ ClassName: "StarterGui" }),
		});

		build();

		expect(vi.mocked(buildWithRojo)).toHaveBeenCalledTimes(2);

		build();

		expect(vi.mocked(buildWithRojo)).toHaveBeenCalledTimes(2);
	});

	it("should build every time when no reuse cache is configured", () => {
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
		buildPlace(options);
		buildPlace(options);

		expect(vi.mocked(buildWithRojo)).toHaveBeenCalledTimes(2);
	});
});
