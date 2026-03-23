import { describe, expect, it } from "vitest";

import { parseStack } from "./stack-parser.ts";

describe(parseStack, () => {
	it("should parse single frame", () => {
		expect.assertions(3);

		const input = '[string "ReplicatedStorage.client.lib.test.spec"]:24';

		const result = parseStack(input);

		expect(result.frames).toHaveLength(1);
		expect(result.frames[0]!.dataModelPath).toBe("ReplicatedStorage.client.lib.test.spec");
		expect(result.frames[0]!.line).toBe(24);
	});

	it("should parse multiple frames", () => {
		expect.assertions(3);

		const input = `[string "ReplicatedStorage.foo"]:10
[string "ReplicatedStorage.bar"]:20`;

		const result = parseStack(input);

		expect(result.frames).toHaveLength(2);
		expect(result.frames[0]!.dataModelPath).toBe("ReplicatedStorage.foo");
		expect(result.frames[1]!.dataModelPath).toBe("ReplicatedStorage.bar");
	});

	it("should separate message from frames", () => {
		expect.assertions(2);

		const input = `Error: expected true to be false
[string "ReplicatedStorage.test"]:42`;

		const result = parseStack(input);

		expect(result.message).toBe("Error: expected true to be false");
		expect(result.frames).toHaveLength(1);
	});

	it("should return empty frames for no matches", () => {
		expect.assertions(2);

		const input = "Just an error message with no stack";

		const result = parseStack(input);

		expect(result.frames).toBeEmpty();
		expect(result.message).toBe("Just an error message with no stack");
	});

	it("should parse frame with column number", () => {
		expect.assertions(3);

		const input = '[string "ReplicatedStorage.test"]:24:15';

		const result = parseStack(input);

		expect(result.frames).toHaveLength(1);
		expect(result.frames[0]!.line).toBe(24);
		expect(result.frames[0]!.column).toBe(15);
	});

	it("should snapshot parsed multi-frame stack", () => {
		expect.assertions(1);

		const input = `expect(received).toBe(expected)

Expected: 100
Received: 0
[string "ReplicatedStorage.combat.spec"]:42:15
[string "ReplicatedStorage.combat.utils"]:10`;

		expect(parseStack(input)).toMatchInlineSnapshot(`
			{
			  "frames": [
			    {
			      "column": 15,
			      "dataModelPath": "ReplicatedStorage.combat.spec",
			      "line": 42,
			    },
			    {
			      "column": undefined,
			      "dataModelPath": "ReplicatedStorage.combat.utils",
			      "line": 10,
			    },
			  ],
			  "message": "expect(received).toBe(expected)

			Expected: 100
			Received: 0",
			}
		`);
	});

	it("should parse frame without column as undefined", () => {
		expect.assertions(2);

		const input = '[string "ReplicatedStorage.test"]:24';

		const result = parseStack(input);

		expect(result.frames[0]!.line).toBe(24);
		expect(result.frames[0]!.column).toBeUndefined();
	});
});
