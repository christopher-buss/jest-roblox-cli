import { describe, expect, it } from "vitest";

import {
	normalizeOptionalValueFlags,
	parseParallelValue,
	parseVmParallelValue,
} from "./optional-value-flags.ts";

describe(normalizeOptionalValueFlags, () => {
	it("should write out the bare value of each optional-value flag", () => {
		expect.assertions(1);

		expect(
			normalizeOptionalValueFlags(["--parallel", "--changed", "--experimental-vm-parallel"]),
		).toStrictEqual([
			"--parallel",
			"auto",
			"--changed",
			"HEAD",
			"--experimental-vm-parallel",
			"auto",
		]);
	});

	it("should keep a value that follows its flag", () => {
		expect.assertions(1);

		expect(
			normalizeOptionalValueFlags(["--parallel", "2", "--changed", "main", "src/a.spec.ts"]),
		).toStrictEqual(["--parallel", "2", "--changed", "main", "src/a.spec.ts"]);
	});

	it("should leave a --parallel bare before a positional test path", () => {
		expect.assertions(1);

		expect(normalizeOptionalValueFlags(["--parallel", "src/a.spec.ts"])).toStrictEqual([
			"--parallel",
			"auto",
			"src/a.spec.ts",
		]);
	});
});

describe(parseParallelValue, () => {
	it("should read a count, auto, or no flag", () => {
		expect.assertions(3);

		expect(parseParallelValue("3")).toBe(3);
		expect(parseParallelValue("auto")).toBe("auto");
		expect(parseParallelValue(undefined)).toBeUndefined();
	});
});

describe(parseVmParallelValue, () => {
	it("should read a count, auto, or no flag", () => {
		expect.assertions(3);

		expect(parseVmParallelValue("2")).toBe(2);
		expect(parseVmParallelValue("auto")).toBe("auto");
		expect(parseVmParallelValue(undefined)).toBeUndefined();
	});
});
