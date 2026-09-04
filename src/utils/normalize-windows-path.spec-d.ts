import { describe, expectTypeOf, it } from "vitest";

import type { PosixRoot } from "./normalize-windows-path.ts";
import { toPosixRoot } from "./normalize-windows-path.ts";

/** Stands in for any consumer that requires a canonical root. */
function consume(_root: PosixRoot): void {}

describe(toPosixRoot, () => {
	it("should brand its result so a consumer can demand a canonical root", () => {
		expectTypeOf(toPosixRoot("out/")).toEqualTypeOf<PosixRoot>();
	});

	it("should reject a spelling that nothing canonicalized", () => {
		// @ts-expect-error a raw config spelling is not a canonical root
		consume("./out/");
	});

	it("should satisfy a consumer that demands one", () => {
		consume(toPosixRoot("./out/"));
	});
});
