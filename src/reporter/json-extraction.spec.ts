import { describe, expect, it } from "vitest";

import { extractJsonFromOutput } from "./json-extraction.ts";

describe(extractJsonFromOutput, () => {
	it("should extract JSON from output with surrounding text", () => {
		expect.assertions(1);

		const output = `
Some log output here
{"success":true,"numTotalTests":1}
More logs after
`;
		const json = extractJsonFromOutput(output);

		expect(json).toBe('{"success":true,"numTotalTests":1}');
	});

	it("should extract multi-line JSON object", () => {
		expect.assertions(1);

		const output = `
{
  "success": true,
  "numTotalTests": 2
}
`;
		const json = extractJsonFromOutput(output);

		expect(JSON.parse(json!)).toStrictEqual({
			numTotalTests: 2,
			success: true,
		});
	});

	it("should return undefined when no JSON found", () => {
		expect.assertions(1);

		const output = "Just plain text output";
		const json = extractJsonFromOutput(output);

		expect(json).toBeUndefined();
	});

	it("should skip brace-balanced but invalid JSON", () => {
		expect.assertions(1);

		const output = "{foo}\nmore text";
		const json = extractJsonFromOutput(output);

		expect(json).toBeUndefined();
	});

	it("should reset after an invalid candidate and return the next valid object", () => {
		expect.assertions(1);

		const output = ["prefix", "  {notJson}", "between", '  {"success":true}', "suffix"].join(
			"\n",
		);

		expect(extractJsonFromOutput(output)).toBe('{"success":true}');
	});

	it("should ignore a line that parses as JSON but opens no object", () => {
		expect.assertions(1);

		// Valid json, and balanced, so only the `{` gate rejects it.
		const output = ['"hello"', '{"a":1}'].join("\n");

		expect(extractJsonFromOutput(output)).toBe('{"a":1}');
	});

	it("should not restart the scan at a nested object already inside the envelope", () => {
		expect.assertions(1);

		// The gate applies only while the scan is idle, or the nested object
		// becomes the candidate and the envelope around it is lost.
		const output = ['{"a":', '{"b":1}', "}"].join("\n");

		expect(extractJsonFromOutput(output)).toBe(output);
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

		expect(extractJsonFromOutput(output)).toBe(
			["{", '    "nested": {', '      "value": true', "    }", "  }"].join("\n"),
		);
	});
});
