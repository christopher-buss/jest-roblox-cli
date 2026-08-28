import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { CoverageManifest } from "../coverage-pipeline/manifest.ts";
import { MANIFEST_VERSION } from "../coverage-pipeline/manifest.ts";
import {
	computePlaceInputsKey,
	readPlaceReuseRecord,
	writePlaceReuseRecord,
} from "./place-reuse.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

const ROOT = "/cache";
const PROJECT_FILE = "/cache/synthesized.project.json";

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

function keyFor({
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
	return computePlaceInputsKey({
		manifests,
		projectFile: PROJECT_FILE,
		projectJson,
		shadowRoots,
		stagingVersion,
	});
}

describe(computePlaceInputsKey, () => {
	it("should report the same key when nothing changed", () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "/cache/assets/model.txt": "one" });

		const first = keyFor();

		expect(first).toBeString();
		expect(keyFor()).toBe(first);
	});

	it("should report a different key when a walked input changes", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "/cache/assets/model.txt": "one" });
		const before = keyFor();

		vol.fromJSON({ "/cache/assets/model.txt": "two" });

		expect(keyFor()).not.toBe(before);
	});

	it("should report a different key when an instrumented source hash changes", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const before = keyFor({
			manifests: [manifest({ files: { "src/a.luau": fromAny({ sourceHash: "aaa" }) } })],
		});

		const after = keyFor({
			manifests: [manifest({ files: { "src/a.luau": fromAny({ sourceHash: "bbb" }) } })],
		});

		expect(after).not.toBe(before);
	});

	it("should report a different key when a non-instrumented source hash changes", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const before = keyFor({
			manifests: [
				manifest({
					nonInstrumentedFiles: { "src/a.json": fromAny({ sourceHash: "aaa" }) },
				}),
			],
		});

		const after = keyFor({
			manifests: [
				manifest({
					nonInstrumentedFiles: { "src/a.json": fromAny({ sourceHash: "bbb" }) },
				}),
			],
		});

		expect(after).not.toBe(before);
	});

	it("should report a different key when the instrumenter version bumps", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		const before = keyFor({ manifests: [manifest({ instrumenterVersion: 1 })] });

		expect(keyFor({ manifests: [manifest({ instrumenterVersion: 2 })] })).not.toBe(before);
	});

	it("should leave shadow roots out of the walk", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "/cache/shadow/a.luau": "one" });
		const shadowProject = project({ Shadow: "shadow" });
		const before = keyFor({ projectJson: shadowProject, shadowRoots: ["shadow"] });

		vol.fromJSON({ "/cache/shadow/a.luau": "two" });

		expect(keyFor({ projectJson: shadowProject, shadowRoots: ["shadow"] })).toBe(before);
	});

	it("should key on the project text, not the file the project file names", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		// Nothing at PROJECT_FILE: the key is planned before the project is
		// written, so reading it back would find the run before this one.
		vol.fromJSON({ "/cache/assets/model.txt": "one" });

		expect(keyFor()).toBeString();
	});

	it("should report a different key when the staging pass version bumps", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		// The passes that run between this key and the built place are code,
		// not inputs: nothing on disk moves when what they emit changes.
		vol.fromJSON({ "/cache/assets/model.txt": "one" });
		const before = keyFor({ stagingVersion: 1 });

		expect(keyFor({ stagingVersion: 2 })).not.toBe(before);
	});

	it("should report undefined and warn when the project text cannot be parsed", () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(keyFor({ projectJson: "{ not json" })).toBeUndefined();
		expect(warn.mock.calls.flat().join("")).toContain("could not hash rojo build inputs");
	});
});

describe(readPlaceReuseRecord, () => {
	it("should round-trip a written record", () => {
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

	it("should report undefined when no record exists", () => {
		expect.assertions(1);

		expect(readPlaceReuseRecord("/cache/missing.json")).toBeUndefined();
	});

	it("should report undefined for malformed json", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "/cache/place.json": "{ truncated" });

		expect(readPlaceReuseRecord("/cache/place.json")).toBeUndefined();
	});

	it("should report undefined when the record has the wrong shape", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "/cache/place.json": JSON.stringify({ inputsKey: 7 }) });

		expect(readPlaceReuseRecord("/cache/place.json")).toBeUndefined();
	});
});
