import { describe, expect, it } from "vitest";

import { normalizeRawCoverage, parseCoverageEnvelope } from "./raw-coverage.ts";

describe(normalizeRawCoverage, () => {
	it("should return undefined for a non-object input", () => {
		expect.assertions(3);

		expect(normalizeRawCoverage(undefined)).toBeUndefined();
		expect(normalizeRawCoverage(null)).toBeUndefined();
		expect(normalizeRawCoverage(42)).toBeUndefined();
	});

	it("should convert Luau 1-based statement arrays to string-keyed records", () => {
		expect.assertions(1);

		const result = normalizeRawCoverage({ "out/init.luau": { s: [3, 0, 5] } });

		expect(result).toStrictEqual({ "out/init.luau": { s: { "1": 3, "2": 0, "3": 5 } } });
	});

	it("should normalize function and nested branch counters", () => {
		expect.assertions(1);

		const result = normalizeRawCoverage({
			"out/m.luau": { b: [[1, 0]], f: [2], s: [1] },
		});

		expect(result).toStrictEqual({
			"out/m.luau": {
				b: { "1": [1, 0] },
				f: { "1": 2 },
				s: { "1": 1 },
			},
		});
	});

	it("should keep the fileKey verbatim — it is the cross-machine join key", () => {
		expect.assertions(1);

		const key = "data-package/src/init.luau";
		const result = normalizeRawCoverage({ [key]: { s: [1] } });

		expect(Object.keys(result!)).toStrictEqual([key]);
	});

	it("should skip entries that carry no statement map", () => {
		expect.assertions(1);

		const result = normalizeRawCoverage({ "out/a.luau": { f: [1] }, "out/b.luau": { s: [1] } });

		expect(result).toStrictEqual({ "out/b.luau": { s: { "1": 1 } } });
	});

	it("should return undefined when no file carries coverage", () => {
		expect.assertions(1);

		expect(normalizeRawCoverage({})).toBeUndefined();
	});

	it("should coerce non-numeric values on the already-keyed statement path to 0", () => {
		expect.assertions(1);

		// `s` arrives as a keyed object (a re-read table), not a Luau array.
		const result = normalizeRawCoverage({ "out/a.luau": { s: { "1": 3, "2": "bad" } } });

		expect(result).toStrictEqual({ "out/a.luau": { s: { "1": 3, "2": 0 } } });
	});

	it("should coerce branch arms given as an already-keyed object", () => {
		expect.assertions(1);

		const result = normalizeRawCoverage({
			"out/a.luau": { b: { "1": [1, "x"], "2": "nope" }, s: [1] },
		});

		expect(result).toStrictEqual({
			"out/a.luau": { b: { "1": [1, 0], "2": [] }, s: { "1": 1 } },
		});
	});
});

describe(parseCoverageEnvelope, () => {
	it("should extract _coverage from a JSON envelope string", () => {
		expect.assertions(1);

		const output = JSON.stringify({
			_coverage: { "out/init.luau": { s: [1] } },
			success: true,
		});

		expect(parseCoverageEnvelope(output)).toStrictEqual({
			"out/init.luau": { s: { "1": 1 } },
		});
	});

	it("should extract _coverage from an already-parsed envelope object", () => {
		expect.assertions(1);

		const envelope = { _coverage: { "out/init.luau": { s: [2] } }, success: true };

		expect(parseCoverageEnvelope(envelope)).toStrictEqual({
			"out/init.luau": { s: { "1": 2 } },
		});
	});

	it("should treat a bare hit table (the _G global) as the coverage itself", () => {
		expect.assertions(1);

		// Machine B reading `_G.__jest_roblox_cov` directly has no `_coverage`
		// wrapper — the object IS the table.
		expect(parseCoverageEnvelope({ "out/init.luau": { s: [1] } })).toStrictEqual({
			"out/init.luau": { s: { "1": 1 } },
		});
	});

	it("should return undefined for a malformed JSON string", () => {
		expect.assertions(1);

		expect(parseCoverageEnvelope("not json {")).toBeUndefined();
	});

	it("should return undefined for a JSON string that decodes to a non-object", () => {
		expect.assertions(1);

		// Valid JSON, but a scalar — not a coverage table.
		expect(parseCoverageEnvelope("42")).toBeUndefined();
	});

	it("should return undefined for a non-string, non-object input", () => {
		expect.assertions(1);

		// The signature accepts `unknown` (callers often hold raw run output); a
		// bare scalar is neither an envelope nor a hit table.
		expect(parseCoverageEnvelope(42)).toBeUndefined();
	});

	it("should return undefined when the envelope carries no coverage", () => {
		expect.assertions(1);

		expect(parseCoverageEnvelope({ success: true })).toBeUndefined();
	});
});
