import { createMemoryFileSystem } from "@isentinel/dev-vitest-utils";

import { describe, it } from "vitest";

import { copyIgnoreMatcher } from "#test/helpers/unit/coverage-copy-ignore.ts";
import { MANIFEST_VERSION } from "#test/helpers/unit/coverage-versions.ts";
import { posixRoot } from "#test/helpers/unit/posix-root.ts";
import type { CoverageManifest } from "../coverage-data/manifest.ts";
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
	it("should report a change when a cached file's shadow output is gone", ({ expect }) => {
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
