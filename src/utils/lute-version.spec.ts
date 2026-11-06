import { describe, expect, it } from "vitest";

import { isSupportedLuteVersion } from "./lute-version.ts";

describe(isSupportedLuteVersion, () => {
	it("should accept a major 1 version as the last word", () => {
		expect.assertions(3);

		expect(isSupportedLuteVersion("1.0.1")).toBeTrue();
		expect(isSupportedLuteVersion("v1.2.3-nightly.4")).toBeTrue();
		expect(isSupportedLuteVersion("lute 1.0.1")).toBeTrue();
	});

	it("should reject another major or output that is not a version", () => {
		expect.assertions(3);

		expect(isSupportedLuteVersion("2.1.0")).toBeFalse();
		expect(isSupportedLuteVersion("1.0")).toBeFalse();
		expect(isSupportedLuteVersion("usage: lute")).toBeFalse();
	});
});
