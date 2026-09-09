import { describe, expect, it } from "vitest";

import { canReuseCoverageManifest } from "./incremental-gate.ts";
import type { InstrumentUniverse } from "./instrument-universe.ts";
import { INSTRUMENTER_VERSION } from "./instrumenter.ts";
import { MANIFEST_VERSION } from "./manifest.ts";
import type { CoverageManifest } from "./manifest.ts";

function manifestWithUniverse(coverageUniverseHash: string): CoverageManifest {
	return {
		buildId: "previous",
		copyIgnoreHash: "copy-ignore",
		coverageUniverseHash,
		files: {},
		generatedAt: "2026-09-08T00:00:00.000Z",
		instrumenterVersion: INSTRUMENTER_VERSION,
		luauRoots: [],
		nonInstrumentedFiles: {},
		shadowDir: "/shadow",
		version: MANIFEST_VERSION,
	};
}

describe(canReuseCoverageManifest, () => {
	it("should reject a manifest created for another coverage universe", () => {
		expect.assertions(1);

		const universe = {
			digest: "current-universe",
			includes: () => true,
		} satisfies InstrumentUniverse;

		expect(
			canReuseCoverageManifest(manifestWithUniverse("previous-universe"), {
				copyIgnoreHash: "copy-ignore",
				coverageCache: true,
				universe,
			}),
		).toBeFalse();
	});
});
