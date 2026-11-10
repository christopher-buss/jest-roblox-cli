import { type } from "arktype";
import { describe, expect, it } from "vitest";

import { objectDefinition, rowsOf } from "./option-row.ts";

describe(rowsOf, () => {
	it("should attach each key and the location", () => {
		expect.assertions(1);

		expect(rowsOf("root", { port: { jest: true } })).toStrictEqual([
			{ key: "port", jest: true, location: "root" },
		]);
	});
});

describe(objectDefinition, () => {
	it("should build a rejecting object with optional keys by default", () => {
		expect.assertions(3);

		const schema = type(objectDefinition(rowsOf("root", { port: { schema: type("number") } })));

		expect(schema({})).not.toBeInstanceOf(type.errors);
		expect(schema({ port: "x" })).toBeInstanceOf(type.errors);
		expect(schema({ other: 1 })).toBeInstanceOf(type.errors);
	});

	it("should require the keys the predicate names", () => {
		expect.assertions(1);

		const schema = type(
			objectDefinition(rowsOf("root", { port: { schema: type("number") } }), () => true),
		);

		expect(schema({})).toBeInstanceOf(type.errors);
	});
});
