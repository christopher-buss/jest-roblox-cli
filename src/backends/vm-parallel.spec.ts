import { describe, expect, it } from "vitest";

import { resolveVmHostCount, VM_HOST_POOL_SIZE } from "./vm-parallel.ts";

describe(resolveVmHostCount, () => {
	it("should stay sequential when no parallelism was asked for", () => {
		expect.assertions(1);

		expect(resolveVmHostCount(undefined, 3)).toBeUndefined();
	});

	it.for([
		["auto", 3, 3],
		["auto", 10, VM_HOST_POOL_SIZE],
		["auto", 1, undefined],
		[2, 5, 2],
		[2.9, 5, 2],
		[8, 3, 3],
		[8, 10, VM_HOST_POOL_SIZE],
		[1, 5, undefined],
		[0, 5, undefined],
	] as const)("should resolve %j over %i configs to %j", ([requested, configCount, expected]) => {
		expect.assertions(1);

		expect(resolveVmHostCount(requested, configCount)).toBe(expected);
	});
});
