import { describe, expect, it } from "vitest";

import { findJestJsonCandidate } from "./json-extraction.ts";

describe(findJestJsonCandidate, () => {
	it("should extract JSON from output with surrounding text", () => {
		expect.assertions(1);

		const output = `
Some log output here
{"success":true,"numTotalTests":1}
More logs after
`;
		const json = findJestJsonCandidate(output);

		expect(json).toBe('{"success":true,"numTotalTests":1}');
	});

	it("should extract multi-line JSON object", () => {
		expect.assertions(1);

		const output = `
log line
{
  "success": true,
  "numTotalTests": 2
}
`;
		const json = findJestJsonCandidate(output);

		expect(JSON.parse(json!)).toStrictEqual({
			numTotalTests: 2,
			success: true,
		});
	});

	it("should return undefined when no JSON found", () => {
		expect.assertions(1);

		const output = "Just plain text output";
		const json = findJestJsonCandidate(output);

		expect(json).toBeUndefined();
	});

	it("should skip brace-balanced but invalid JSON", () => {
		expect.assertions(1);

		const output = "{foo}\nmore text";
		const json = findJestJsonCandidate(output);

		expect(json).toBeUndefined();
	});

	it("should reset after an invalid candidate and return the next valid object", () => {
		expect.assertions(1);

		const output = ["prefix", "  {notJson}", "between", '  {"success":true}', "suffix"].join(
			"\n",
		);

		expect(findJestJsonCandidate(output)).toBe('{"success":true}');
	});

	it("should ignore a line that parses as JSON but opens no object", () => {
		expect.assertions(1);

		// Valid json, and balanced, so only the `{` gate rejects it.
		const output = ['"hello"', '{"a":1}'].join("\n");

		expect(findJestJsonCandidate(output)).toBe('{"a":1}');
	});

	it("should not restart the scan at a nested object already inside the envelope", () => {
		expect.assertions(1);

		// The gate applies only while the scan is idle, or the nested object
		// becomes the candidate and the envelope around it is lost.
		const envelope = ['{"a":', '{"b":1}', "}"].join("\n");

		expect(findJestJsonCandidate(`log line\n${envelope}`)).toBe(envelope);
	});

	it("should collect every line until a nested object is balanced", () => {
		expect.assertions(1);

		const output = [
			"prefix",
			"  {",
			'    "nested": {',
			'      "value": true',
			"    }",
			"  }",
			"suffix",
		].join("\n");

		expect(findJestJsonCandidate(output)).toBe(
			["{", '    "nested": {', '      "value": true', "    }", "  }"].join("\n"),
		);
	});

	it("should return the whole trimmed output when it is JSON", () => {
		expect.assertions(1);

		expect(findJestJsonCandidate('  {"a":1}\n')).toBe('{"a":1}');
	});

	it("should scan for a block when output opens with a brace but is not JSON", () => {
		expect.assertions(1);

		expect(findJestJsonCandidate('{oops}\n{"a":1}')).toBe('{"a":1}');
	});
});
