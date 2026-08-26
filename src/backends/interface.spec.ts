import { describe, expect, it } from "vitest";

import { isExplicitMultiShard, isShardedParallel } from "./interface.ts";

describe("parallel predicates", () => {
	it("should treat one session as serial and larger counts as sharded", () => {
		expect.assertions(4);

		expect(isShardedParallel(1)).toBeFalse();
		expect(isExplicitMultiShard(1)).toBeFalse();
		expect(isShardedParallel(2)).toBeTrue();
		expect(isExplicitMultiShard(2)).toBeTrue();
	});

	it("should treat auto as sharded but not explicitly multi-session", () => {
		expect.assertions(2);

		expect(isShardedParallel("auto")).toBeTrue();
		expect(isExplicitMultiShard("auto")).toBeFalse();
	});
});
