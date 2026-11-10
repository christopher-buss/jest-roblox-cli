import { describe, expect, it } from "vitest";

import { mergeRawCoverage } from "./merge-raw-coverage.ts";

describe(mergeRawCoverage, () => {
	it("should union disjoint files", () => {
		expect.assertions(1);

		const result = mergeRawCoverage(
			{ "a.luau": { s: { "0": 1 } } },
			{ "b.luau": { s: { "0": 2 } } },
		);

		expect(result).toStrictEqual({
			"a.luau": { s: { "0": 1 } },
			"b.luau": { s: { "0": 2 } },
		});
	});

	it("should sum statement hit counts for overlapping files", () => {
		expect.assertions(1);

		const result = mergeRawCoverage(
			{ "a.luau": { s: { "0": 1, "1": 3 } } },
			{ "a.luau": { s: { "0": 3, "1": 0 } } },
		);

		expect(result).toStrictEqual({
			"a.luau": { s: { "0": 4, "1": 3 } },
		});
	});

	it("should sum function hit counts for overlapping files", () => {
		expect.assertions(1);

		const result = mergeRawCoverage(
			{ "a.luau": { f: { "0": 2 }, s: { "0": 1 } } },
			{ "a.luau": { f: { "0": 5 }, s: { "0": 1 } } },
		);

		expect(result).toStrictEqual({
			"a.luau": { f: { "0": 7 }, s: { "0": 2 } },
		});
	});

	it("should sum branch arm counts element-wise", () => {
		expect.assertions(1);

		const result = mergeRawCoverage(
			{ "a.luau": { b: { "0": [1, 0] }, s: { "0": 1 } } },
			{ "a.luau": { b: { "0": [0, 2] }, s: { "0": 1 } } },
		);

		expect(result).toStrictEqual({
			"a.luau": { b: { "0": [1, 2] }, s: { "0": 2 } },
		});
	});

	it("should keep f from target when source has no f", () => {
		expect.assertions(1);

		const result = mergeRawCoverage(
			{ "a.luau": { f: { "0": 3 }, s: { "0": 1 } } },
			{ "a.luau": { s: { "0": 2 } } },
		);

		expect(result).toStrictEqual({
			"a.luau": { f: { "0": 3 }, s: { "0": 3 } },
		});
	});

	it("should keep f from source when target has no f", () => {
		expect.assertions(1);

		const result = mergeRawCoverage(
			{ "a.luau": { s: { "0": 1 } } },
			{ "a.luau": { f: { "0": 4 }, s: { "0": 2 } } },
		);

		expect(result).toStrictEqual({
			"a.luau": { f: { "0": 4 }, s: { "0": 3 } },
		});
	});

	it("should keep b from target when source has no b", () => {
		expect.assertions(1);

		const result = mergeRawCoverage(
			{ "a.luau": { b: { "0": [3, 1] }, s: { "0": 1 } } },
			{ "a.luau": { s: { "0": 2 } } },
		);

		expect(result).toStrictEqual({
			"a.luau": { b: { "0": [3, 1] }, s: { "0": 3 } },
		});
	});

	it("should keep b from source when target has no b", () => {
		expect.assertions(1);

		const result = mergeRawCoverage(
			{ "a.luau": { s: { "0": 1 } } },
			{ "a.luau": { b: { "0": [1, 2] }, s: { "0": 2 } } },
		);

		expect(result).toStrictEqual({
			"a.luau": { b: { "0": [1, 2] }, s: { "0": 3 } },
		});
	});

	it("should sum statement keys that exist only in one side", () => {
		expect.assertions(1);

		const result = mergeRawCoverage(
			{ "a.luau": { s: { "0": 1 } } },
			{ "a.luau": { s: { "1": 5 } } },
		);

		expect(result).toStrictEqual({
			"a.luau": { s: { "0": 1, "1": 5 } },
		});
	});

	it("should sum branch arrays when target is longer", () => {
		expect.assertions(1);

		const result = mergeRawCoverage(
			{ "a.luau": { b: { "0": [1, 4, 5] }, s: { "0": 1 } } },
			{ "a.luau": { b: { "0": [2] }, s: { "0": 1 } } },
		);

		expect(result).toStrictEqual({
			"a.luau": { b: { "0": [3, 4, 5] }, s: { "0": 2 } },
		});
	});

	it("should sum branch arrays when source is longer", () => {
		expect.assertions(1);

		const result = mergeRawCoverage(
			{ "a.luau": { b: { "0": [1] }, s: { "0": 1 } } },
			{ "a.luau": { b: { "0": [0, 2, 3] }, s: { "0": 1 } } },
		);

		expect(result).toStrictEqual({
			"a.luau": { b: { "0": [1, 2, 3] }, s: { "0": 2 } },
		});
	});

	it("should return source when target is undefined", () => {
		expect.assertions(1);

		const source = { "a.luau": { s: { "0": 1 } } };

		expect(mergeRawCoverage(undefined, source)).toStrictEqual(source);
	});

	it("should return target when source is undefined", () => {
		expect.assertions(1);

		const target = { "a.luau": { s: { "0": 1 } } };

		expect(mergeRawCoverage(target, undefined)).toStrictEqual(target);
	});
});
