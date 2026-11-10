import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { posixRoot } from "#test/mocks/posix-path.ts";
import { toPathRedirects } from "./coverage-root.ts";

const PACKAGE = path.resolve("/repo/packages/foo");

describe(toPathRedirects, () => {
	it("should resolve each root against the package directory", () => {
		expect.assertions(1);

		expect(
			toPathRedirects(PACKAGE, [
				{ luauRoot: posixRoot("out"), shadowDir: String.raw`C:\shadow\out` },
			]),
		).toStrictEqual([{ from: posixRoot(path.join(PACKAGE, "out")), to: "C:/shadow/out" }]);
	});

	it("should drop a trailing separator from the resolved root", () => {
		expect.assertions(1);

		expect(
			toPathRedirects(PACKAGE, [{ luauRoot: posixRoot("out/"), shadowDir: "/shadow" }])[0]!
				.from,
		).toBe(posixRoot(path.join(PACKAGE, "out")));
	});
});
