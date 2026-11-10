import { describe, expect, it } from "vitest";

import {
	isCountValue,
	parseBackend,
	parseCoverageReporters,
	parseFormatterNames,
	parseParallel,
	parsePositiveInteger,
	parseVmParallel,
} from "./option-parsers.ts";

describe(parsePositiveInteger, () => {
	it("should parse a positive integer", () => {
		expect.assertions(1);

		expect(parsePositiveInteger("port")("4000")).toBe(4000);
	});

	it("should accept 1, the smallest positive integer", () => {
		expect.assertions(1);

		expect(parsePositiveInteger("port")("1")).toBe(1);
	});

	it("should name the flag when the value is not one", () => {
		expect.assertions(1);

		expect(() => parsePositiveInteger("port")("0")).toThrow(
			'Invalid --port value "0". Must be a positive integer.',
		);
	});
});

describe(parseBackend, () => {
	it("should reject an unknown backend", () => {
		expect.assertions(1);

		expect(() => parseBackend("nope")).toThrow('Invalid backend "nope"');
	});
});

describe(parseCoverageReporters, () => {
	it("should keep known reporters", () => {
		expect.assertions(1);

		expect(parseCoverageReporters(["text", "lcov"])).toStrictEqual(["text", "lcov"]);
	});
});

describe(parseFormatterNames, () => {
	it("should keep known formatter names", () => {
		expect.assertions(1);

		expect(parseFormatterNames(["agent", "json"])).toStrictEqual(["agent", "json"]);
	});

	it("should name every unknown formatter", () => {
		expect.assertions(1);

		expect(() => parseFormatterNames(["fancy", "json", "x"])).toThrow(
			'Invalid formatter "fancy", "x". Must be one of: agent, default, github-actions, json',
		);
	});
});

describe(isCountValue, () => {
	it.for([
		["auto", true],
		["3", true],
		["src/a.spec.ts", false],
	] as const)("should read %j as a count: %j", ([next, isCount]) => {
		expect.assertions(1);

		expect(isCountValue(next)).toBe(isCount);
	});
});

describe(parseParallel, () => {
	it("should parse auto and counts", () => {
		expect.assertions(2);

		expect(parseParallel("auto")).toBe("auto");
		expect(parseParallel("2")).toBe(2);
	});
});

describe(parseVmParallel, () => {
	it("should parse auto and counts", () => {
		expect.assertions(2);

		expect(parseVmParallel("auto")).toBe("auto");
		expect(parseVmParallel("2")).toBe(2);
	});
});
