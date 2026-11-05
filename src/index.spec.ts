import { describe, expect, it } from "vitest";

import * as entry from "./index.ts";

describe("artifacts entry point", () => {
	it("should retain the supported runtime exports", () => {
		expect.assertions(1);

		expect(Object.keys(entry).sort()).toStrictEqual(
			[
				"BUILD_MANIFEST_VERSION",
				"DEFAULT_CONFIG",
				"GLOBAL_TEST_KEYS",
				"JEST_ARGV_EXCLUDED_KEYS",
				"MANIFEST_VERSION",
				"OpenCloudBackend",
				"ROOT_CLI_KEYS",
				"SHARED_TEST_KEYS",
				"StudioBackend",
				"StudioCliBackend",
				"atomicWrite",
				"buildCoveragePlaceAsync",
				"buildJestArgv",
				"buildManifestSchema",
				"coverageManifestSchema",
				"createOpenCloudBackend",
				"createStudioBackend",
				"createStudioCliBackend",
				"defineConfig",
				"defineProject",
				"extractJsonFromOutput",
				"formatAnnotations",
				"formatExecuteOutput",
				"formatFailure",
				"formatGameOutputNotice",
				"formatJobSummary",
				"formatJson",
				"formatResult",
				"formatTestSummary",
				"generateTestScript",
				"hashFile",
				"loadConfig",
				"mergeRawCoverage",
				"normalizeRawCoverage",
				"parseCoverageEnvelope",
				"parseGameOutput",
				"parseJestOutput",
				"parseVersionedManifest",
				"prepareArtifactsAsync",
				"readBuildManifest",
				"readCoverageManifest",
				"resolveConfig",
				"resolveLayoutProject",
				"runJestRobloxAsync",
				"runProjectsAsync",
				"runTypecheckAsync",
				"visitBlock",
				"visitExpression",
				"visitStatement",
				"writeGameOutput",
				"writeJsonFileAsync",
			].sort(),
		);
	});
});
