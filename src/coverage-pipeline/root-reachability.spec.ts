import { describe, expect, it } from "vitest";

import { collectRojoMounts, resolveMountWithin } from "./root-reachability.ts";

describe(resolveMountWithin, () => {
	it.for(["/", "D:/"])("should exclude the namespace frame itself for %s", (frame) => {
		expect.assertions(1);

		expect(resolveMountWithin(frame, { frame, rojoDirectory: frame })).toBeUndefined();
	});
});

describe(collectRojoMounts, () => {
	it("should return only declared mounts and collapse repeated paths", () => {
		expect.assertions(1);

		expect(
			collectRojoMounts(
				{
					$className: "DataModel",
					First: { $path: "out" },
					Second: { $path: "out" },
				},
				"D:/project",
			),
		).toStrictEqual(new Set(["D:/project/out"]));
	});
});
