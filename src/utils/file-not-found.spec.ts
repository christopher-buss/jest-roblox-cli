import { describe, expect, it } from "vitest";

import { isFileNotFound } from "./file-not-found.ts";

describe(isFileNotFound, () => {
	it("should accept an error with the ENOENT code", () => {
		expect.assertions(1);

		expect(isFileNotFound(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBeTrue();
	});

	it("should reject other codes, codeless errors and non-errors", () => {
		expect.assertions(3);

		expect(isFileNotFound(Object.assign(new Error("denied"), { code: "EACCES" }))).toBeFalse();
		expect(isFileNotFound(new Error("plain"))).toBeFalse();
		expect(isFileNotFound({ code: "ENOENT" })).toBeFalse();
	});
});
