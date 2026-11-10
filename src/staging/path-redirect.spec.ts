import { describe, expect, it } from "vitest";

import { posixRoot } from "#test/mocks/posix-path.ts";
import { redirectPath } from "./path-redirect.ts";

describe(redirectPath, () => {
	function redirects() {
		return [
			{ from: posixRoot("/repo/out"), to: "/repo/.shadow/out" },
			{ from: posixRoot("/repo/lib"), to: "/repo/.shadow/lib" },
		];
	}

	it("should rewrite a path inside a redirect into its target", () => {
		expect.assertions(1);

		expect(redirectPath("/repo/lib/shared/a.luau", redirects())).toBe(
			"/repo/.shadow/lib/shared/a.luau",
		);
	});

	it("should land an exact match on the target directory itself", () => {
		expect.assertions(1);

		expect(redirectPath("/repo/out", redirects())).toBe("/repo/.shadow/out");
	});

	it("should return undefined for a path outside every redirect", () => {
		expect.assertions(1);

		expect(redirectPath("/repo/out-tsc/a.luau", redirects())).toBeUndefined();
	});
});
