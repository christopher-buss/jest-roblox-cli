import { describe, expect, it } from "vitest";

import * as entry from "./index.ts";

describe("package root entry", () => {
	it("should retain the supported runtime exports", () => {
		expect.assertions(1);

		expect(Object.keys(entry).sort()).toStrictEqual(
			[
				"BUILD_MANIFEST_VERSION",
				"MANIFEST_VERSION",
				"atomicWrite",
				"buildManifestSchema",
				"coverageManifestSchema",
				"defineConfig",
				"defineProject",
				"hashFile",
				"parseVersionedManifest",
				"readBuildManifest",
				"readCoverageManifest",
			].sort(),
		);
	});
});
