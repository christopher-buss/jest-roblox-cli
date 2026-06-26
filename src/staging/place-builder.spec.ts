import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import { Buffer } from "node:buffer";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { hashBuffer } from "../utils/hash.ts";
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

		vi.mocked(synthesize).mockReturnValue("PROJECT_JSON");
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

		vi.mocked(synthesize).mockReturnValue("PROJECT_JSON");
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

		expect(vol.readFileSync(PROJECT_FILE, "utf8")).toBe("PROJECT_JSON");
		expect(buildWithRojo).toHaveBeenCalledWith(PROJECT_FILE, PLACE_FILE);
	});

	it("should forward wrap and loadStringEnabled to synthesize", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vi.mocked(synthesize).mockReturnValue("PROJECT_JSON");
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

		vi.mocked(synthesize).mockReturnValue("PROJECT_JSON");
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
