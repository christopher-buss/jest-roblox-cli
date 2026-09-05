import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import type { MemoryVolume } from "../../test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { hashBuffer, hashFile } from "../utils/hash.ts";
import type {
	BuildManifest,
	BuildManifestProject,
	CoverageArtifacts,
	ReadBuildManifestResult,
} from "./build-manifest.ts";
import {
	BUILD_MANIFEST_VERSION,
	emitBuildManifest,
	readBuildManifest,
	writeBuildManifest,
} from "./build-manifest.ts";

const COVERAGE_PLACE = "/project/.jest-roblox/coverage/game.rbxl";
const CLEAN_PLACE = "/project/.jest-roblox/coverage/clean.rbxl";
const SOURCE_FILE = "/project/out/init.luau";
const COVERAGE_PLACE_CONTENT = "COV-RBXL-BYTES";
const CLEAN_PLACE_CONTENT = "RBXL-BYTES";
const SOURCE_CONTENT = "local x = 1";

function seedArtifacts(volume: MemoryVolume): void {
	volume.mkdirSync("/project/.jest-roblox/coverage", { recursive: true });
	volume.mkdirSync("/project/out", { recursive: true });
	volume.writeFileSync(COVERAGE_PLACE, COVERAGE_PLACE_CONTENT);
	volume.writeFileSync(CLEAN_PLACE, CLEAN_PLACE_CONTENT);
	volume.writeFileSync(SOURCE_FILE, SOURCE_CONTENT);
}

// Hashes derive from the content constants, not from disk, so a fixture stays
// valid even after a test unlinks or tampers with the artifacts. The example
// carries both places (the shape `prepareArtifacts` emits); the coverage path
// emits only `coveragePlace`, exercised via the `cleanPlace: undefined` case.
function exampleManifest(overrides: Partial<BuildManifest> = {}): BuildManifest {
	return {
		buildId: "11111111-1111-1111-1111-111111111111",
		cleanPlace: { hash: hashBuffer(Buffer.from(CLEAN_PLACE_CONTENT)), path: CLEAN_PLACE },
		coveragePlace: {
			hash: hashBuffer(Buffer.from(COVERAGE_PLACE_CONTENT)),
			path: COVERAGE_PLACE,
		},
		files: { [SOURCE_FILE]: { sourceHash: hashBuffer(Buffer.from(SOURCE_CONTENT)) } },
		generatedAt: "2026-06-06T00:00:00.000Z",
		projects: [],
		version: BUILD_MANIFEST_VERSION,
		...overrides,
	};
}

function exampleArtifacts(): CoverageArtifacts {
	return {
		buildId: "11111111-1111-1111-1111-111111111111",
		coveragePlace: {
			hash: hashBuffer(Buffer.from(COVERAGE_PLACE_CONTENT)),
			path: COVERAGE_PLACE,
		},
		files: { [SOURCE_FILE]: { sourceHash: hashBuffer(Buffer.from(SOURCE_CONTENT)) } },
		generatedAt: "2026-06-06T00:00:00.000Z",
		projects: [],
		rebuilt: true,
	};
}

function expectOk(result: ReadBuildManifestResult): BuildManifest {
	if (result.kind !== "ok") {
		throw new Error(`expected ok, got ${result.kind}`);
	}

	return result.manifest;
}

const MANIFEST_PATH = "/project/.jest-roblox/coverage/build-manifest.json";

// Callers pass an already-serialized manifest: serializing at the call site
// keeps the concrete type, so the stricter JSON.stringify typing returns a
// `string` rather than a possibly-`undefined` result.
function seedManifest(volume: MemoryVolume, json: string): void {
	volume.mkdirSync("/project/.jest-roblox/coverage", { recursive: true });
	volume.writeFileSync(MANIFEST_PATH, json);
}

describe(writeBuildManifest, () => {
	it("should round-trip through readBuildManifest when artifacts match on disk", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedArtifacts(volume);

		const manifest = exampleManifest();
		writeBuildManifest(MANIFEST_PATH, manifest, fileSystem);

		expect(expectOk(readBuildManifest(MANIFEST_PATH, { fileSystem }))).toStrictEqual(manifest);
	});

	it("should create parent directories before writing", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedArtifacts(volume);

		writeBuildManifest("/nested/dir/build-manifest.json", exampleManifest(), fileSystem);

		expect(volume.existsSync("/nested/dir/build-manifest.json")).toBeTrue();
	});
});

describe(emitBuildManifest, () => {
	it("should emit a coverage-only manifest when no clean place is given", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedArtifacts(volume);

		emitBuildManifest(MANIFEST_PATH, exampleArtifacts(), undefined, fileSystem);

		const manifest = expectOk(readBuildManifest(MANIFEST_PATH, { fileSystem }));

		expect(manifest.coveragePlace.path).toBe(COVERAGE_PLACE);
		expect(manifest.cleanPlace).toBeUndefined();
	});

	it("should emit both places when a clean place is given", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedArtifacts(volume);

		emitBuildManifest(
			MANIFEST_PATH,
			exampleArtifacts(),
			{ hash: hashBuffer(Buffer.from(CLEAN_PLACE_CONTENT)), path: CLEAN_PLACE },
			fileSystem,
		);

		expect(expectOk(readBuildManifest(MANIFEST_PATH, { fileSystem })).cleanPlace!.path).toBe(
			CLEAN_PLACE,
		);
	});

	it("should record the projects carried by the coverage artifacts", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedArtifacts(volume);

		const project: BuildManifestProject = {
			displayName: "client",
			projectDataModelPath: "ReplicatedStorage/client",
			setupFiles: ["ReplicatedStorage/setup"],
			setupFilesAfterEnv: [],
			testMatch: ["**/*.spec"],
		};
		emitBuildManifest(
			MANIFEST_PATH,
			{ ...exampleArtifacts(), projects: [project] },
			undefined,
			fileSystem,
		);

		expect(expectOk(readBuildManifest(MANIFEST_PATH, { fileSystem })).projects).toStrictEqual([
			project,
		]);
	});
});

describe(readBuildManifest, () => {
	it("should accept a manifest carrying a populated project entry", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedArtifacts(volume);

		const manifest = exampleManifest({
			projects: [
				{
					displayName: "client",
					jestDataModelPath: "game.ReplicatedStorage.jest",
					projectDataModelPath: "game.ReplicatedStorage.client",
					setupFiles: ["game.ReplicatedStorage.setup"],
					setupFilesAfterEnv: [],
					testMatch: ["**/*.spec"],
				},
			],
		});
		seedManifest(volume, JSON.stringify(manifest));

		expect(expectOk(readBuildManifest(MANIFEST_PATH, { fileSystem }))).toStrictEqual(manifest);
	});

	it("should return missing when the file does not exist", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(readBuildManifest("/nonexistent/build-manifest.json", { fileSystem }).kind).toBe(
			"missing",
		);
	});

	it("should return malformed-json when the file is not valid JSON", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/project/.jest-roblox/coverage", { recursive: true });

		volume.writeFileSync(MANIFEST_PATH, "{ not json");

		expect(readBuildManifest(MANIFEST_PATH, { fileSystem }).kind).toBe("malformed-json");
	});

	it("should return invalid when the JSON root is not an object", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/project/.jest-roblox/coverage", { recursive: true });

		volume.writeFileSync(MANIFEST_PATH, JSON.stringify(["not", "an", "object"]));

		expect(readBuildManifest(MANIFEST_PATH, { fileSystem }).kind).toBe("invalid");
	});

	it("should return invalid when the JSON root is the literal null", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/project/.jest-roblox/coverage", { recursive: true });

		volume.writeFileSync(MANIFEST_PATH, "null");

		expect(readBuildManifest(MANIFEST_PATH, { fileSystem }).kind).toBe("invalid");
	});

	it("should return invalid when the JSON root is a primitive", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/project/.jest-roblox/coverage", { recursive: true });

		volume.writeFileSync(MANIFEST_PATH, "5");

		expect(readBuildManifest(MANIFEST_PATH, { fileSystem }).kind).toBe("invalid");
	});

	it("should return invalid (not version-mismatch) when version is absent", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedManifest(volume, JSON.stringify({ generatedAt: "x" }));

		expect(readBuildManifest(MANIFEST_PATH, { fileSystem }).kind).toBe("invalid");
	});

	it("should return version-mismatch when version is a different number", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedManifest(
			volume,
			JSON.stringify({ ...exampleManifest(), version: BUILD_MANIFEST_VERSION + 1 }),
		);

		const result = readBuildManifest(MANIFEST_PATH, { fileSystem });

		expect(result.kind).toBe("version-mismatch");

		expect(result).toMatchObject({ actual: BUILD_MANIFEST_VERSION + 1 });
	});

	it("should return invalid when version matches but the body fails schema", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedManifest(volume, JSON.stringify({ buildId: 123, version: BUILD_MANIFEST_VERSION }));

		expect(readBuildManifest(MANIFEST_PATH, { fileSystem }).kind).toBe("invalid");
	});

	it("should propagate non-ENOENT IO errors rather than misreport as malformed-json", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync(MANIFEST_PATH, { recursive: true });

		expect(() => readBuildManifest(MANIFEST_PATH, { fileSystem })).toThrow(/EISDIR|illegal/i);
	});

	it("should return buildid-mismatch when expectedBuildId differs", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedArtifacts(volume);

		seedManifest(volume, JSON.stringify(exampleManifest()));

		const result = readBuildManifest(MANIFEST_PATH, {
			expectedBuildId: "other-id",
			fileSystem,
		});

		expect(result.kind).toBe("buildid-mismatch");
		expect(result).toMatchObject({ actual: "11111111-1111-1111-1111-111111111111" });
	});

	it("should return ok when expectedBuildId matches", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedArtifacts(volume);

		seedManifest(volume, JSON.stringify(exampleManifest()));

		expect(
			readBuildManifest(MANIFEST_PATH, {
				expectedBuildId: "11111111-1111-1111-1111-111111111111",
				fileSystem,
			}).kind,
		).toBe("ok");
	});

	it("should return missing-referenced-artifact when the clean place is absent", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedArtifacts(volume);

		volume.unlinkSync(CLEAN_PLACE);
		seedManifest(volume, JSON.stringify(exampleManifest()));

		const result = readBuildManifest(MANIFEST_PATH, { fileSystem });

		expect(result.kind).toBe("missing-referenced-artifact");
		expect(result).toMatchObject({ path: CLEAN_PLACE });
	});

	it("should return clean-place-hash-mismatch when the clean place content changed", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedArtifacts(volume);

		const manifest = exampleManifest();
		seedManifest(volume, JSON.stringify(manifest));
		volume.writeFileSync(CLEAN_PLACE, "TAMPERED");

		const result = readBuildManifest(MANIFEST_PATH, { fileSystem });

		expect(result.kind).toBe("clean-place-hash-mismatch");
		expect(result).toMatchObject({ path: CLEAN_PLACE });
	});

	it("should refuse on clean place drift before checking source drift", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedArtifacts(volume);

		seedManifest(volume, JSON.stringify(exampleManifest()));
		// Both the place and a source file drift; the place is reported first.
		volume.writeFileSync(CLEAN_PLACE, "TAMPERED");
		volume.writeFileSync(SOURCE_FILE, "local x = 99");

		expect(readBuildManifest(MANIFEST_PATH, { fileSystem }).kind).toBe(
			"clean-place-hash-mismatch",
		);
	});

	it("should return missing-referenced-artifact when the coverage place is absent", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedArtifacts(volume);

		volume.unlinkSync(COVERAGE_PLACE);
		seedManifest(volume, JSON.stringify(exampleManifest()));

		const result = readBuildManifest(MANIFEST_PATH, { fileSystem });

		expect(result.kind).toBe("missing-referenced-artifact");
		expect(result).toMatchObject({ path: COVERAGE_PLACE });
	});

	it("should return coverage-place-hash-mismatch when the coverage place content changed", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedArtifacts(volume);

		seedManifest(volume, JSON.stringify(exampleManifest()));
		volume.writeFileSync(COVERAGE_PLACE, "TAMPERED");

		const result = readBuildManifest(MANIFEST_PATH, { fileSystem });

		expect(result.kind).toBe("coverage-place-hash-mismatch");
		expect(result).toMatchObject({ path: COVERAGE_PLACE });
	});

	it("should refuse on coverage place drift before clean place drift", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedArtifacts(volume);

		seedManifest(volume, JSON.stringify(exampleManifest()));
		// Both places drift; the coverage place is reported first.
		volume.writeFileSync(COVERAGE_PLACE, "TAMPERED");
		volume.writeFileSync(CLEAN_PLACE, "TAMPERED");

		expect(readBuildManifest(MANIFEST_PATH, { fileSystem }).kind).toBe(
			"coverage-place-hash-mismatch",
		);
	});

	it("should return ok when cleanPlace is omitted (coverage-only manifest)", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedArtifacts(volume);

		seedManifest(volume, JSON.stringify({ ...exampleManifest(), cleanPlace: undefined }));

		expect(readBuildManifest(MANIFEST_PATH, { fileSystem }).kind).toBe("ok");
	});

	it("should still verify the coverage place when cleanPlace is omitted", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedArtifacts(volume);

		seedManifest(volume, JSON.stringify({ ...exampleManifest(), cleanPlace: undefined }));
		volume.writeFileSync(COVERAGE_PLACE, "TAMPERED");

		expect(readBuildManifest(MANIFEST_PATH, { fileSystem }).kind).toBe(
			"coverage-place-hash-mismatch",
		);
	});

	it("should return missing-referenced-artifact when a source file is absent", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedArtifacts(volume);

		volume.unlinkSync(SOURCE_FILE);
		seedManifest(volume, JSON.stringify(exampleManifest()));

		const result = readBuildManifest(MANIFEST_PATH, { fileSystem });

		expect(result.kind).toBe("missing-referenced-artifact");
		expect(result).toMatchObject({ path: SOURCE_FILE });
	});

	it("should return source-drift when a source file content changed", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		seedArtifacts(volume);

		seedManifest(volume, JSON.stringify(exampleManifest()));
		volume.writeFileSync(SOURCE_FILE, "local x = 2");

		const result = readBuildManifest(MANIFEST_PATH, { fileSystem });

		expect(result.kind).toBe("source-drift");
		expect(result).toMatchObject({ path: SOURCE_FILE });
	});

	it("should resolve artifact paths against rootDir when provided", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/base/out", { recursive: true });

		volume.writeFileSync("/base/place.rbxl", "RBXL-BYTES");
		volume.writeFileSync("/base/game.rbxl", "COV-RBXL-BYTES");
		volume.writeFileSync("/base/out/init.luau", "local x = 1");
		volume.mkdirSync("/base/.jest-roblox/coverage", { recursive: true });
		const manifest = exampleManifest({
			cleanPlace: { hash: hashFile("/base/place.rbxl", fileSystem), path: "place.rbxl" },
			coveragePlace: { hash: hashFile("/base/game.rbxl", fileSystem), path: "game.rbxl" },
			files: { "out/init.luau": { sourceHash: hashFile("/base/out/init.luau", fileSystem) } },
		});
		volume.writeFileSync(
			"/base/.jest-roblox/coverage/build-manifest.json",
			JSON.stringify(manifest),
		);

		expect(
			readBuildManifest("/base/.jest-roblox/coverage/build-manifest.json", {
				fileSystem,
				rootDir: "/base",
			}).kind,
		).toBe("ok");
	});
});
