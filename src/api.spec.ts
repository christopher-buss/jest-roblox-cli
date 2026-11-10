import { describe, expect, it } from "vitest";

import * as entry from "./api.ts";

describe("api entry point", () => {
	it("should retain the supported runtime exports", () => {
		expect.assertions(1);

		expect(Object.keys(entry).sort()).toStrictEqual(
			[
				"BUILD_MANIFEST_VERSION",
				"MANIFEST_VERSION",
				"atomicWrite",
				"runTypecheckAsync",
				"runProjectsAsync",
				"formatFailure",
				"createStyles",
				"OpenCloudBackend",
				"DEFAULT_CONFIG",
				"buildCoveragePlaceAsync",
				"buildJestArgv",
				"buildManifestSchema",
				"coverageManifestSchema",
				"defineConfig",
				"defineProject",
				"formatJson",
				"formatResult",
				"hashFile",
				"loadConfig",
				"normalizeRawCoverage",
				"parseCoverageEnvelope",
				"parseVersionedManifest",
				"prepareArtifactsAsync",
				"readBuildManifest",
				"readCoverageManifest",
				"resolveConfig",
				"resolveLayoutProject",
				"runJestRobloxAsync",
			].sort(),
		);
	});
});
