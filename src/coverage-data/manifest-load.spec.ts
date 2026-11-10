import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { MANIFEST_VERSION } from "#test/mocks/coverage-versions.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { loadPriorManifest } from "./manifest-load.ts";
import type { CoverageManifest } from "./manifest.ts";

const MANIFEST_PATH = "/cache/coverage-manifest.json";
const LABEL = "Test coverage manifest";

function seedManifest(contents: string) {
	const memory = createMemoryFileSystem();
	memory.volume.mkdirSync("/cache", { recursive: true });
	memory.volume.writeFileSync(MANIFEST_PATH, contents);
	return memory;
}

describe(loadPriorManifest, () => {
	it("should answer undefined without a warning when no manifest exists", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(
			loadPriorManifest({ fileSystem, label: LABEL, manifestPath: MANIFEST_PATH }),
		).toBeUndefined();
		expect(stderr).not.toHaveBeenCalled();
	});

	it("should name the manifest in the warning when its JSON is malformed", () => {
		expect.assertions(2);

		const { fileSystem } = seedManifest("{");
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(
			loadPriorManifest({ fileSystem, label: LABEL, manifestPath: MANIFEST_PATH }),
		).toBeUndefined();
		expect(stderr).toHaveBeenCalledExactlyOnceWith(
			`Warning: ${LABEL} is malformed JSON (cache discarded)\n`,
		);
	});

	it("should name the manifest in the warning when it fails the schema", () => {
		expect.assertions(2);

		const { fileSystem } = seedManifest(JSON.stringify({ version: MANIFEST_VERSION }));
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(
			loadPriorManifest({ fileSystem, label: LABEL, manifestPath: MANIFEST_PATH }),
		).toBeUndefined();
		expect(stderr).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining(`Warning: ${LABEL} is invalid (cache discarded): `),
		);
	});

	it("should answer the manifest when it reads cleanly", () => {
		expect.assertions(1);

		const manifest: CoverageManifest = {
			buildId: "build",
			copyIgnoreHash: "copy",
			files: {},
			generatedAt: "2026-01-01T00:00:00.000Z",
			instrumenterVersion: 1,
			luauRoots: [],
			nonInstrumentedFiles: {},
			shadowDir: "/cache",
			version: MANIFEST_VERSION,
		};
		const { fileSystem } = seedManifest(JSON.stringify(manifest));

		expect(
			loadPriorManifest({ fileSystem, label: LABEL, manifestPath: MANIFEST_PATH }),
		).toStrictEqual(manifest);
	});
});
