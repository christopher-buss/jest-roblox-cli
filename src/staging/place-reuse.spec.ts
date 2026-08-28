import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as nodeFs from "node:fs";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { ageFile } from "../../test/mocks/aged-file.ts";
import type { CoverageManifest } from "../coverage-pipeline/manifest.ts";
import { MANIFEST_VERSION } from "../coverage-pipeline/manifest.ts";
import {
	computePlaceInputsKeyAsync,
	readPlaceReuseRecord,
	writePlaceReuseRecord,
} from "./place-reuse.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

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

async function keyForAsync({
	manifests = [],
	projectJson = project({ Assets: "assets" }),
	shadowRoots = [],
	stagingVersion = 1,
}: {
	manifests?: Array<CoverageManifest>;
	projectJson?: string;
	shadowRoots?: Array<string>;
	stagingVersion?: number;
} = {}) {
	return computePlaceInputsKeyAsync({
		digestCacheFile: DIGEST_CACHE,
		manifests,
		projectFile: PROJECT_FILE,
		projectJson,
		shadowRoots,
		stagingVersion,
	});
}

describe(computePlaceInputsKeyAsync, () => {
	it("should not re-read a mount whose stat stood still", async () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "/cache/assets/model.txt": "one" });
		ageFile("/cache/assets/model.txt", 60);
		const first = await keyForAsync();

		const readFile = vi.spyOn(nodeFs.promises, "readFile");

		await expect(keyForAsync()).resolves.toBe(first);
		expect(readFile).not.toHaveBeenCalledWith("/cache/assets/model.txt");
	});

	it("should report the same key when nothing changed", async () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "/cache/assets/model.txt": "one" });

		const first = await keyForAsync();

		expect(first).toBeString();
		await expect(keyForAsync()).resolves.toBe(first);
	});

	it("should report a different key when a walked input changes", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "/cache/assets/model.txt": "one" });
		const before = await keyForAsync();

		vol.fromJSON({ "/cache/assets/model.txt": "two" });

		await expect(keyForAsync()).resolves.not.toBe(before);
	});

	it("should report a different key when an instrumented source hash changes", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const before = await keyForAsync({
			manifests: [manifest({ files: { "src/a.luau": fromAny({ sourceHash: "aaa" }) } })],
		});

		const after = await keyForAsync({
			manifests: [manifest({ files: { "src/a.luau": fromAny({ sourceHash: "bbb" }) } })],
		});

		expect(after).not.toBe(before);
	});

	it("should report a different key when a non-instrumented source hash changes", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const before = await keyForAsync({
			manifests: [
				manifest({
					nonInstrumentedFiles: { "src/a.json": fromAny({ sourceHash: "aaa" }) },
				}),
			],
		});

		const after = await keyForAsync({
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

		onTestFinished(() => {
			vol.reset();
		});

		const before = await keyForAsync({ manifests: [manifest({ instrumenterVersion: 1 })] });

		await expect(
			keyForAsync({ manifests: [manifest({ instrumenterVersion: 2 })] }),
		).resolves.not.toBe(before);
	});

	it("should leave shadow roots out of the walk", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "/cache/shadow/a.luau": "one" });
		const shadowProject = project({ Shadow: "shadow" });
		const before = await keyForAsync({ projectJson: shadowProject, shadowRoots: ["shadow"] });

		vol.fromJSON({ "/cache/shadow/a.luau": "two" });

		await expect(
			keyForAsync({ projectJson: shadowProject, shadowRoots: ["shadow"] }),
		).resolves.toBe(before);
	});

	it("should key on the project text, not the file the project file names", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		// Nothing at PROJECT_FILE: the key is planned before the project is
		// written, so reading it back would find the run before this one.
		vol.fromJSON({ "/cache/assets/model.txt": "one" });

		await expect(keyForAsync()).resolves.toBeString();
	});

	it("should report a different key when the staging pass version bumps", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		// The passes that run between this key and the built place are code,
		// not inputs: nothing on disk moves when what they emit changes.
		vol.fromJSON({ "/cache/assets/model.txt": "one" });
		const before = await keyForAsync({ stagingVersion: 1 });

		await expect(keyForAsync({ stagingVersion: 2 })).resolves.not.toBe(before);
	});

	it("should report the same key when the manifests arrive in a different order", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

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

		await expect(keyForAsync({ manifests: [second, first] })).resolves.toBe(
			await keyForAsync({ manifests: [first, second] }),
		);
	});

	it("should report undefined and warn when the project text cannot be parsed", async () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		await expect(keyForAsync({ projectJson: "{ not json" })).resolves.toBeUndefined();
		expect(warn.mock.calls.flat().join("")).toContain("could not hash rojo build inputs");
	});
});

describe(readPlaceReuseRecord, () => {
	it("should round-trip a written record", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.mkdirSync(ROOT, { recursive: true });
		writePlaceReuseRecord("/cache/place.json", { inputsKey: "key", placeHash: "hash" });

		expect(readPlaceReuseRecord("/cache/place.json")).toStrictEqual({
			inputsKey: "key",
			placeHash: "hash",
		});
	});

	it("should report undefined when no record exists", async () => {
		expect.assertions(1);

		expect(readPlaceReuseRecord("/cache/missing.json")).toBeUndefined();
	});

	it("should report undefined for malformed json", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "/cache/place.json": "{ truncated" });

		expect(readPlaceReuseRecord("/cache/place.json")).toBeUndefined();
	});

	it("should report undefined when the record has the wrong shape", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "/cache/place.json": JSON.stringify({ inputsKey: 7 }) });

		expect(readPlaceReuseRecord("/cache/place.json")).toBeUndefined();
	});
});
