import { fromAny, fromPartial } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { COVERAGE_PLACE_FILE } from "#test/mocks/coverage-versions.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { bakeCoveragePlaceAsync } from "./coverage-place.ts";
import type { CoverageManifest } from "./manifest.ts";
import type { CoverageInputs } from "./prepare-types.ts";

function unchangedShadow() {
	return {
		changed: false,
		coverageRoots: [],
		coverageSpine: [],
		files: {},
		nonInstrumentedFiles: {},
	};
}

describe(bakeCoveragePlaceAsync, () => {
	it("should reuse the cached place when nothing changed since it was built", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.mkdirSync(path.dirname(COVERAGE_PLACE_FILE), { recursive: true });
		volume.writeFileSync(COVERAGE_PLACE_FILE, "RBXL");
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const previousManifest = fromPartial<CoverageManifest>({
			buildId: "prior",
			generatedAt: "2026-01-01T00:00:00.000Z",
			placeFilePath: COVERAGE_PLACE_FILE,
		});
		const inputs = fromPartial<CoverageInputs>({
			buildManifestPath: "/missing/build-manifest.json",
			fileSystem,
			narrowed: [],
			previousManifest,
			rojoInputsHash: undefined,
			rojoProjectPath: "/project/default.project.json",
		});

		const result = await bakeCoveragePlaceAsync({
			bake: undefined,
			childProcess: fromAny({}),
			codeRoots: undefined,
			config: createResolvedConfig({ rootDir: "/project" }),
			instrumented: { inputs, isIncremental: true, shadow: unchangedShadow() },
		});

		expect(result).toMatchObject({ buildId: "prior", rebuilt: false });
		expect(result.manifest).toBe(previousManifest);
	});
});
