import { fromAny } from "@total-typescript/shoehorn";

import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { ageFile } from "../../test/mocks/aged-file.ts";
import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { CoverageManifest } from "../coverage-pipeline/manifest.ts";
import { MANIFEST_VERSION } from "../coverage-pipeline/manifest.ts";
import type { FileSystem } from "../utils/file-system.ts";
import {
	computePlaceInputsKeyAsync,
	readPlaceReuseRecord,
	writePlaceReuseRecord,
} from "./place-reuse.ts";

const ROOT = "/cache";
const PROJECT_FILE = "/cache/synthesized.project.json";
const DIGEST_CACHE = "/cache/input-digests";

function project(paths: Record<string, string>): string {
	const tree: Record<string, unknown> = { $className: "DataModel" };
	for (const [name, mount] of Object.entries(paths)) {
		tree[name] = { $path: mount };
	}

	return JSON.stringify({ name: "synthesized", tree });
}

function manifest(overrides: Partial<CoverageManifest> = {}): CoverageManifest {
	return {
		buildId: "build-1",
		files: {},
		generatedAt: "2026-01-01T00:00:00.000Z",
		instrumenterVersion: 1,
		luauRoots: [],
		nonInstrumentedFiles: {},
		shadowDir: "/cache/shadow",
		version: MANIFEST_VERSION,
		...overrides,
	};
}

async function keyForAsync(
	fileSystem: FileSystem,
	{
		manifests = [],
		projectJson = project({ Assets: "assets" }),
		shadowRoots = [],
		stagingVersions = [1],
	}: {
		manifests?: Array<CoverageManifest>;
		projectJson?: string;
		shadowRoots?: Array<string>;
		stagingVersions?: ReadonlyArray<number>;
	} = {},
) {
	return computePlaceInputsKeyAsync({
		digestCacheFile: DIGEST_CACHE,
		fileSystem,
		manifests,
		projectFile: PROJECT_FILE,
		projectJson,
		shadowRoots,
		stagingVersions,
	});
}

describe(computePlaceInputsKeyAsync, () => {
	it("should not re-read a mount whose stat stood still", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({ "/cache/assets/model.txt": "one" });

		ageFile(fileSystem, "/cache/assets/model.txt", 60);
		const first = await keyForAsync(fileSystem);

		const readFile = vi.spyOn(fileSystem.promises, "readFile");

		await expect(keyForAsync(fileSystem)).resolves.toBe(first);
		expect(readFile).not.toHaveBeenCalledWith("/cache/assets/model.txt");
	});

	it("should report the same key when nothing changed", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({ "/cache/assets/model.txt": "one" });

		const first = await keyForAsync(fileSystem);

		expect(first).toBeString();
		await expect(keyForAsync(fileSystem)).resolves.toBe(first);
	});

	it("should report a different key when a walked input changes", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem({ "/cache/assets/model.txt": "one" });

		const before = await keyForAsync(fileSystem);

		volume.fromJSON({ "/cache/assets/model.txt": "two" });

		await expect(keyForAsync(fileSystem)).resolves.not.toBe(before);
	});

	it("should report a different key when an instrumented source hash changes", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const before = await keyForAsync(fileSystem, {
			manifests: [manifest({ files: { "src/a.luau": fromAny({ sourceHash: "aaa" }) } })],
		});

		const after = await keyForAsync(fileSystem, {
			manifests: [manifest({ files: { "src/a.luau": fromAny({ sourceHash: "bbb" }) } })],
		});

		expect(after).not.toBe(before);
	});

	it("should report a different key when a non-instrumented source hash changes", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const before = await keyForAsync(fileSystem, {
			manifests: [
				manifest({
					nonInstrumentedFiles: { "src/a.json": fromAny({ sourceHash: "aaa" }) },
				}),
			],
		});

		const after = await keyForAsync(fileSystem, {
			manifests: [
				manifest({
					nonInstrumentedFiles: { "src/a.json": fromAny({ sourceHash: "bbb" }) },
				}),
			],
		});

		expect(after).not.toBe(before);
	});

	it("should report a different key when the instrumenter version bumps", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const before = await keyForAsync(fileSystem, {
			manifests: [manifest({ instrumenterVersion: 1 })],
		});

		await expect(
			keyForAsync(fileSystem, { manifests: [manifest({ instrumenterVersion: 2 })] }),
		).resolves.not.toBe(before);
	});

	it("should leave shadow roots out of the walk", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem({ "/cache/shadow/a.luau": "one" });

		const shadowProject = project({ Shadow: "shadow" });
		const before = await keyForAsync(fileSystem, {
			projectJson: shadowProject,
			shadowRoots: ["shadow"],
		});

		volume.fromJSON({ "/cache/shadow/a.luau": "two" });

		await expect(
			keyForAsync(fileSystem, { projectJson: shadowProject, shadowRoots: ["shadow"] }),
		).resolves.toBe(before);
	});

	it("should key on the project text, not the file the project file names", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		// Nothing at PROJECT_FILE: the key is planned before the project is
		// written, so reading it back would find the run before this one.
		volume.fromJSON({ "/cache/assets/model.txt": "one" });

		await expect(keyForAsync(fileSystem)).resolves.toBeString();
	});

	it("should report a different key when the staging pass version bumps", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		// The passes that run between this key and the built place are code,
		// not inputs: nothing on disk moves when what they emit changes.
		volume.fromJSON({ "/cache/assets/model.txt": "one" });

		const before = await keyForAsync(fileSystem, { stagingVersions: [1] });

		await expect(keyForAsync(fileSystem, { stagingVersions: [2] })).resolves.not.toBe(before);
	});

	it("should report a different key when two pass versions concatenate the same", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		// Two passes at 1 and 2 is a different rule from one pass at 12, and a
		// key that ran them together could not tell a bump from a no-op.
		volume.fromJSON({ "/cache/assets/model.txt": "one" });

		const before = await keyForAsync(fileSystem, { stagingVersions: [1, 2] });

		await expect(keyForAsync(fileSystem, { stagingVersions: [12] })).resolves.not.toBe(before);
	});

	it("should report the same key when the manifests arrive in a different order", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		// Manifests arrive in whatever order the packages were prepared in.
		// Sorting the lines is what keeps that order from reading as a
		// changed input and rebuilding a place that is already on disk.
		const first = manifest({
			files: { "src/a.luau": fromAny({ sourceHash: "aaa" }) },
			shadowDir: "/cache/shadow-a",
		});

		const second = manifest({
			files: { "src/b.luau": fromAny({ sourceHash: "bbb" }) },
			shadowDir: "/cache/shadow-b",
		});

		await expect(keyForAsync(fileSystem, { manifests: [second, first] })).resolves.toBe(
			await keyForAsync(fileSystem, { manifests: [first, second] }),
		);
	});

	it("should report undefined and warn when the project text cannot be parsed", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();

		const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		await expect(
			keyForAsync(fileSystem, { projectJson: "{ not json" }),
		).resolves.toBeUndefined();

		expect(warn.mock.calls.flat().join("")).toContain("could not hash rojo build inputs");
	});
});

describe(readPlaceReuseRecord, () => {
	it("should round-trip a written record", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync(ROOT, { recursive: true });

		writePlaceReuseRecord(
			"/cache/place.json",
			{ inputsKey: "key", placeHash: "hash" },
			fileSystem,
		);

		expect(readPlaceReuseRecord("/cache/place.json", fileSystem)).toStrictEqual({
			inputsKey: "key",
			placeHash: "hash",
		});
	});

	it("should report undefined when no record exists", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(readPlaceReuseRecord("/cache/missing.json", fileSystem)).toBeUndefined();
	});

	it("should report undefined for malformed json", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ "/cache/place.json": "{ truncated" });

		expect(readPlaceReuseRecord("/cache/place.json", fileSystem)).toBeUndefined();
	});

	it("should report undefined when the record has the wrong shape", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			"/cache/place.json": JSON.stringify({ inputsKey: 7 }),
		});

		expect(readPlaceReuseRecord("/cache/place.json", fileSystem)).toBeUndefined();
	});
});
