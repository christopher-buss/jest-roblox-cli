import { describe, expect, it } from "vitest";

import * as artifacts from "./artifacts.ts";

describe("artifact contract", () => {
	it("should retain the supported runtime exports", () => {
		expect.assertions(1);

		expect(Object.keys(artifacts).sort()).toStrictEqual(
			[
				"BUILD_MANIFEST_VERSION",
				"MANIFEST_VERSION",
				"atomicWrite",
				"buildManifestSchema",
				"coverageManifestSchema",
				"hashFile",
				"parseVersionedManifest",
				"readBuildManifest",
				"readCoverageManifest",
			].sort(),
		);
	});
});
