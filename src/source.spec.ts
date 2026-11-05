import { describe, expect, it } from "vitest";

import * as source from "./source.ts";

describe("source entry point", () => {
	it("should retain the supported runtime exports", () => {
		expect.assertions(1);

		expect(Object.keys(source).sort()).toStrictEqual(
			[
				"BUILD_MANIFEST_VERSION",
				"DEFAULT_CONFIG",
				"GLOBAL_TEST_KEYS",
				"JEST_ARGV_EXCLUDED_KEYS",
				"MANIFEST_VERSION",
				"PROJECT_TEST_KEYS",
				"ROOT_CLI_KEYS",
				"ROOT_CLI_KEYS_LIST",
				"SHARED_TEST_KEYS",
				"VALID_BACKENDS",
				"VALID_COVERAGE_REPORTERS",
				"absolutePathSchema",
				"atomicWrite",
				"buildManifestSchema",
				"configSchema",
				"coverageManifestSchema",
				"defineConfig",
				"defineProject",
				"hashFile",
				"isCoverageReporter",
				"isValidBackend",
				"parseVersionedManifest",
				"projectConfigFileSchema",
				"readBuildManifest",
				"readCoverageManifest",
				"resolvePlaceFilePath",
				"validateConfig",
				"validateConfigLayer",
			].sort(),
		);
	});
});
