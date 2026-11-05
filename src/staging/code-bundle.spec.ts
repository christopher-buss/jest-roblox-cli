import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { MAX_CODE_BUNDLE_BYTES, writeCodeBundle } from "./code-bundle.ts";
import type { CodeSplit } from "./code-split.ts";

const PLACE_FILE = "/cache/harness.rbxl";
const BUNDLE_FILE = path.join("/cache", "harness.code-bundle.json");

function split(bundleJson: string): CodeSplit {
	return { bundleJson, fileCount: 2, harnessProjectJson: "{}", stayedMounts: ["Mixed"] };
}

describe(writeCodeBundle, () => {
	it("should cap a bundle at the 100 MB Open Cloud accepts as a binary input", () => {
		expect.assertions(1);

		expect(MAX_CODE_BUNDLE_BYTES).toBe(100 * 1024 * 1024);
	});

	it("should write the bundle beside its place, named after it", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const artifact = writeCodeBundle({
			fileSystem,
			maximumBytes: 64,
			placeFile: PLACE_FILE,
			split: split('{"a":"é"}'),
		});

		expect(artifact).toStrictEqual({
			byteLength: 10,
			fileCount: 2,
			path: BUNDLE_FILE,
			stayedMounts: ["Mixed"],
		});
		expect(volume.readFileSync(BUNDLE_FILE, "utf-8")).toBe('{"a":"é"}');
	});

	it("should accept a bundle exactly at the cap", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		writeCodeBundle({
			fileSystem,
			maximumBytes: 8,
			placeFile: PLACE_FILE,
			split: split("12345678"),
		});

		expect(volume.statSync(BUNDLE_FILE).size).toBe(8);
	});

	it("should refuse a bundle over the cap before writing it", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		expect(() => {
			writeCodeBundle({
				fileSystem,
				maximumBytes: 2048,
				placeFile: PLACE_FILE,
				split: split("x".repeat(2049)),
			});
		}).toThrow(
			expect.objectContaining({
				hint: expect.stringContaining("inside the place"),
				message: expect.stringContaining(
					"over the 2.0 KB cap Open Cloud puts on a binary input",
				),
			}),
		);
		expect(volume.existsSync(BUNDLE_FILE)).toBeFalse();
	});
});
