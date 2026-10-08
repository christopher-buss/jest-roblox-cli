import { assert, describe, expect, it } from "vitest";

import type { CstParseResult } from "./cst-materialize.ts";
import { loadLuauParser } from "./parser.ts";

describe("parser diagnostics", () => {
	it("should decode marked AST errors and discard empty lines", () => {
		expect.assertions(1);

		const parser = loadLuauParser({
			injectCstFault: () => {},
			parseToCstJson: (source) => source,
			parseToJson: () => "\u0001first parse error\n\nsecond parse error\n",
		});

		expect(parser.parse("local =")).toStrictEqual({
			errors: ["first parse error", "second parse error"],
			ok: false,
		});
	});

	it("should decode marked CST errors without treating them as tree JSON", () => {
		expect.assertions(1);

		const parser = loadLuauParser({
			injectCstFault: () => {},
			parseToCstJson: () => "\u0001first parse error\n\nsecond parse error\n",
			parseToJson: (source) => source,
		});

		expect(parser.parseCst({ fileName: "invalid.luau", source: "local =" })).toStrictEqual({
			errors: ["first parse error", "second parse error"],
			ok: false,
		});
	});
});

describe("decode of a malformed wrapper payload", () => {
	it("should fail loudly when the JSON is not a parse output", () => {
		expect.assertions(1);

		const parser = loadLuauParser({
			injectCstFault: () => {},
			parseToCstJson: (source) => source,
			parseToJson: (source) => source,
		});

		expect(() => parser.parse('{"unexpected": true}')).toThrow(
			"wasm wrapper returned an unrecognized JSON shape",
		);
	});

	it("should fail loudly when the JSON is not even an object", () => {
		expect.assertions(1);

		const parser = loadLuauParser({
			injectCstFault: () => {},
			parseToCstJson: (source) => source,
			parseToJson: (source) => source,
		});

		expect(() => parser.parse("[1, 2]")).toThrow(
			"wasm wrapper returned an unrecognized JSON shape",
		);
	});

	it("should fail loudly on an unrecognized location string", () => {
		expect.assertions(1);

		const parser = loadLuauParser({
			injectCstFault: () => {},
			parseToCstJson: (source) => source,
			parseToJson: (source) => source,
		});

		expect(() => parser.parse('{"location": "not a span"}')).toThrow(
			"unrecognized location string",
		);
	});
});

const SOURCE = "local x = 1";

interface TreeOverrides {
	name?: string;
	keyword?: string;
}

/**
 * Parse one serializer payload against its original source.
 * @param options - The diagnostic file name and source text.
 * @param payload - The serializer JSON or failure message.
 * @returns The materialized tree or serializer errors.
 */
function parseWithPayload(
	{ fileName, source = SOURCE }: { fileName: string; source?: string },
	payload: string,
): CstParseResult {
	return loadLuauParser({
		injectCstFault: () => {},
		parseToCstJson: () => payload,
		parseToJson: (input) => input,
	}).parseCst({ fileName, source });
}

/**
 * The tree for `local x = 1`, with chosen token positions substituted.
 * @returns The serializer JSON for a local declaration.
 * @param overrides - Substituted token positions.
 */
function localStatement(overrides: TreeOverrides): string {
	const keyword = overrides.keyword ?? "[0,0,0,5]";
	const name = overrides.name ?? "[0,6,0,7]";
	return `{"type":"Root","location":[0,0,0,11],"body":{"type":"Block","location":[0,0,0,11],"body":[{"type":"Local","location":[0,0,0,11],"keyword":${keyword},"variables":[{"node":{"type":"LocalDecl","location":[0,6,0,7],"binding":1,"name":${name}}}],"equals":[0,8,0,9],"values":[{"node":{"type":"Number","location":[0,10,0,11],"token":[0,10,0,11]}}]}]}}`;
}

describe("gap detector", () => {
	it("should name the file, the two tokens, and the bytes when a token is skipped", () => {
		expect.assertions(1);

		// The name token points at the `=`, so `x` falls into the gap between
		// `local` and `=` with whitespace on both sides.
		const result = parseWithPayload(
			{ fileName: "skipped.luau" },
			localStatement({ name: "[0,8,0,9]" }),
		);

		assert(!result.ok);

		expect(result.errors).toStrictEqual([
			'skipped.luau: bytes "x" between token "local" at 1:1 and token "=" at 1:9 are not whitespace or a comment',
		]);
	});

	it("should name the start of the file when bytes precede the first token", () => {
		expect.assertions(1);

		const result = parseWithPayload(
			{ fileName: "first.luau" },
			localStatement({ keyword: "[0,2,0,5]" }),
		);

		assert(!result.ok);

		expect(result.errors).toStrictEqual([
			'first.luau: bytes "lo" between the start of the file and token "cal" at 1:3 are not whitespace or a comment',
		]);
	});

	it("should treat an unterminated block comment as offending bytes", () => {
		expect.assertions(1);

		const source = `${SOURCE} --[[ open`;
		const result = parseWithPayload({ fileName: "open.luau", source }, localStatement({}));

		assert(!result.ok);

		expect(result.errors).toStrictEqual([
			'open.luau: bytes "--[[ open" between token "1" at 1:11 and token "" at 1:22 are not whitespace or a comment',
		]);
	});

	it("should report a token that overlaps the previous one", () => {
		expect.assertions(1);

		const result = parseWithPayload(
			{ fileName: "overlap.luau" },
			localStatement({ name: "[0,4,0,7]" }),
		);

		assert(!result.ok);

		expect(result.errors).toStrictEqual([
			'overlap.luau: token "l x" at 1:5 overlaps token "local" at 1:1',
		]);
	});
});

describe("decode of a malformed CST payload", () => {
	it("should surface a serializer defect as an error result", () => {
		expect.assertions(1);

		const result = parseWithPayload(
			{ fileName: "defect.luau" },
			"\u0002cst writer: close without a matching open",
		);

		expect(result).toStrictEqual({
			errors: ["defect.luau: cst writer: close without a matching open"],
			ok: false,
		});
	});

	it("should fail loudly when the JSON is not a tree", () => {
		expect.assertions(1);

		expect(() => parseWithPayload({ fileName: "shape.luau" }, '{"type":"Nope"}')).toThrow(
			"wasm wrapper returned an unrecognized CST shape",
		);
	});
});

describe("cST location payload", () => {
	it("should reject a location with a nonnumeric coordinate", () => {
		expect.assertions(1);

		const parser = loadLuauParser({
			injectCstFault: () => {},
			parseToCstJson: () => {
				return localStatement({}).replace(
					'"location":[0,0,0,11]',
					'"location":[0,"bad",0,11]',
				);
			},
			parseToJson: (source) => source,
		});

		expect(() => parser.parseCst({ fileName: "invalid.luau", source: SOURCE })).toThrow(
			"wasm wrapper returned an invalid CST location",
		);
	});
});
