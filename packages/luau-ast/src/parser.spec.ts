import { assert, describe, expect, it } from "vitest";

import { loadLuauParser } from "./parser.ts";

describe(loadLuauParser, () => {
	it("should return the same parser instance on repeat loads", () => {
		expect.assertions(1);

		const [first, second] = [loadLuauParser(), loadLuauParser()];

		expect(first).toBe(second);
	});
});

describe("parse", () => {
	it("should parse a local declaration into an AstStatBlock root", () => {
		expect.assertions(2);

		const parser = loadLuauParser();

		const result = parser.parse("local x = 1");

		assert(result.ok);

		expect(result.root.type).toBe("AstStatBlock");

		const [statement] = result.root.body;
		assert(statement!.type === "AstStatLocal");

		expect(statement.vars[0]!.name).toBe("x");
	});

	it("should decode every location into a 1-based exclusive-end span", () => {
		expect.assertions(1);

		const parser = loadLuauParser();

		const result = parser.parse("local x = 1");

		assert(result.ok);

		// "local x = 1" spans columns 1-11, so the exclusive end is 12.
		expect(result.root.body[0]!.location).toStrictEqual({
			beginColumn: 1,
			beginLine: 1,
			endColumn: 12,
			endLine: 1,
		});
	});

	it("should decode nested location fields such as indexLocation", () => {
		expect.assertions(1);

		const parser = loadLuauParser();

		const result = parser.parse("return t.field");

		assert(result.ok);
		const [statement] = result.root.body;
		assert(statement!.type === "AstStatReturn");
		const [expression] = statement.list;
		assert(expression!.type === "AstExprIndexName");

		// ".field" places "field" at columns 10-14, exclusive end 15.
		expect(expression.indexLocation).toStrictEqual({
			beginColumn: 10,
			beginLine: 1,
			endColumn: 15,
			endLine: 1,
		});
	});

	it("should decode comment spans", () => {
		expect.assertions(1);

		const parser = loadLuauParser();

		const result = parser.parse("-- note\nlocal x = 1");

		assert(result.ok);

		expect(result.comments).toStrictEqual([
			{
				location: { beginColumn: 1, beginLine: 1, endColumn: 8, endLine: 1 },
				type: "Comment",
			},
		]);
	});

	it("should survive the encoder's bare Infinity for overflowing literals", () => {
		expect.assertions(1);

		const parser = loadLuauParser();

		const result = parser.parse("local a = 1e999");

		assert(result.ok);
		const [statement] = result.root.body;
		assert(statement!.type === "AstStatLocal");
		const [value] = statement.values;
		assert(value!.type === "AstExprConstantNumber");

		expect(value.value).toBe(Infinity);
	});

	it("should leave the word Infinity alone inside string constants", () => {
		expect.assertions(1);

		const parser = loadLuauParser();

		const result = parser.parse('local s = "to Infinity!"');

		assert(result.ok);
		const [statement] = result.root.body;
		assert(statement!.type === "AstStatLocal");
		const [value] = statement.values;
		assert(value!.type === "AstExprConstantString");

		expect(value.value).toBe("to Infinity!");
	});

	it("should track escaped quotes when scanning for bare Infinity", () => {
		expect.assertions(2);

		const parser = loadLuauParser();

		const result = parser.parse('local s = "she said \\"Infinity\\"" local a = 1e999');

		assert(result.ok);
		const [stringStatement, numberStatement] = result.root.body;
		assert(stringStatement!.type === "AstStatLocal");
		const [stringValue] = stringStatement.values;
		assert(stringValue!.type === "AstExprConstantString");

		expect(stringValue.value).toBe('she said "Infinity"');

		assert(numberStatement!.type === "AstStatLocal");
		const [numberValue] = numberStatement.values;
		assert(numberValue!.type === "AstExprConstantNumber");

		expect(numberValue.value).toBe(Infinity);
	});

	it("should survive a parse whose output outgrows the initial wasm heap", () => {
		expect.assertions(1);

		const parser = loadLuauParser();

		// ~2 MB of statements produce >20 MB of AST JSON, past the default
		// 16 MB initial heap — exercising ALLOW_MEMORY_GROWTH end to end.
		const lines = Array.from(
			{ length: 60_000 },
			(_unused, index) => `local variable${index} = ${index} + ${index}`,
		);

		const result = parser.parse(lines.join("\n"));

		assert(result.ok);

		expect(result.root.body).toHaveLength(60_000);
	});

	it("should report each parse error as a message", () => {
		expect.assertions(2);

		const parser = loadLuauParser();

		const result = parser.parse("local = =");

		assert(!result.ok);

		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toContain("Expected identifier");
	});
});
