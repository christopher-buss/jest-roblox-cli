import { describe, expect, it } from "vitest";

import { copyIgnoreMatcher } from "#test/mocks/coverage-copy-ignore.ts";
import { MANIFEST_VERSION } from "#test/mocks/coverage-versions.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixRoot } from "#test/mocks/posix-path.ts";
import type { CoverageManifest } from "./manifest.ts";
import { computeIncrementalState } from "./shadow-incremental.ts";

function manifestWith(files: CoverageManifest["files"]): CoverageManifest {
	return {
		buildId: "previous",
		files,
		generatedAt: "2026-09-08T00:00:00.000Z",
		instrumenterVersion: 0,
		luauRoots: ["/source"],
		nonInstrumentedFiles: {},
		shadowDir: "/shadow",
		version: MANIFEST_VERSION,
	};
}

describe(computeIncrementalState, () => {
	it("should report a change when a cached file's shadow output is gone", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({ "/source/init.luau": "return nil" });
		const previousManifest = manifestWith({
			"/source/init.luau": {
				key: "/source/init.luau",
				coverageMapPath: "/shadow/init.cov-map.json",
				instrumentedLuauPath: "/shadow/init.luau",
				originalLuauPath: "/source/init.luau",
				sourceHash: "unused",
				sourceMapPath: "/shadow/init.luau.map",
				statementCount: 0,
			},
		});

		const state = computeIncrementalState(
			{
				fileSystem,
				isCopyIgnored: copyIgnoreMatcher([]),
				luauRoot: posixRoot("/source"),
				previousManifest,
			},
			undefined,
		);

		expect(state.changed).toBeTrue();
		expect(state.allCached).toBeFalse();
	});
});
