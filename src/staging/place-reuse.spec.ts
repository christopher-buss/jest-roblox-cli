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

function keyFor(manifests: Array<CoverageManifest>, shadowRoots: Array<string> = []) {
	return computePlaceInputsKey({
		manifests,
		projectFile: PROJECT_FILE,
		shadowRoots,
	});
}

describe(computePlaceInputsKey, () => {
	it("should report the same key when nothing changed", () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({
			"/cache/assets/model.txt": "one",
			[PROJECT_FILE]: project({ Assets: "assets" }),
		});

		const first = keyFor([]);

		expect(first).toBeString();
		expect(keyFor([])).toBe(first);
	});

	it("should report a different key when a walked input changes", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({
			"/cache/assets/model.txt": "one",
			[PROJECT_FILE]: project({ Assets: "assets" }),
		});
		const before = keyFor([]);

		vol.fromJSON({ "/cache/assets/model.txt": "two" });

		expect(keyFor([])).not.toBe(before);
	});

	it("should report a different key when an instrumented source hash changes", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ [PROJECT_FILE]: project({ Assets: "assets" }) });
		const before = keyFor([
			manifest({ files: { "src/a.luau": fromAny({ sourceHash: "aaa" }) } }),
		]);

		const after = keyFor([
			manifest({ files: { "src/a.luau": fromAny({ sourceHash: "bbb" }) } }),
		]);

		expect(after).not.toBe(before);
	});

	it("should report a different key when a non-instrumented source hash changes", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ [PROJECT_FILE]: project({ Assets: "assets" }) });
		const before = keyFor([
			manifest({ nonInstrumentedFiles: { "src/a.json": fromAny({ sourceHash: "aaa" }) } }),
		]);

		const after = keyFor([
			manifest({ nonInstrumentedFiles: { "src/a.json": fromAny({ sourceHash: "bbb" }) } }),
		]);

		expect(after).not.toBe(before);
	});

	it("should report a different key when the instrumenter version bumps", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ [PROJECT_FILE]: project({ Assets: "assets" }) });
		const before = keyFor([manifest({ instrumenterVersion: 1 })]);

		expect(keyFor([manifest({ instrumenterVersion: 2 })])).not.toBe(before);
	});

	it("should leave shadow roots out of the walk", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({
			"/cache/shadow/a.luau": "one",
			[PROJECT_FILE]: project({ Shadow: "shadow" }),
		});
		const before = keyFor([], ["shadow"]);

		vol.fromJSON({ "/cache/shadow/a.luau": "two" });

		expect(keyFor([], ["shadow"])).toBe(before);
	});

	it("should report undefined and warn when the project file cannot be hashed", () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ [PROJECT_FILE]: "{ not json" });
		const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(keyFor([])).toBeUndefined();
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
