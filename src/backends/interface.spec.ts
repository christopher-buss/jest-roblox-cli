import { describe, expect, it } from "vitest";

import { isShardedParallel } from "./interface.ts";

describe(isShardedParallel, () => {
	it("should treat one session as serial and larger counts as sharded", () => {
		expect.assertions(2);

		expect(isShardedParallel(1)).toBeFalse();
		expect(isShardedParallel(2)).toBeTrue();
	});

	it("should treat auto as sharded", () => {
		expect.assertions(1);

		expect(isShardedParallel("auto")).toBeTrue();
	});
});
