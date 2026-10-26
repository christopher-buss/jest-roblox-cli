import { assert, describe, expect, it } from "vitest";

import rawCst from "#test/fixtures/trees/raw-cst.json" with { type: "json" };
import { cstTree, rawTree } from "#test/helpers/unit/trees";
import { materializeCst } from "./cst-materialize.ts";
import type { Trivia } from "./cst-token.ts";

describe(materializeCst, () => {
	it("should preserve whitespace in an empty block's end token", () => {
		expect.assertions(1);

		const result = materializeCst({
			json: '{"type":"Root","location":[0,0,0,1],"body":{"type":"Block","location":[0,0,0,1],"body":[]}}',
			source: " ",
		});

		expect(result).toMatchObject({
			ok: true,
			root: { eof: { leading: [{ kind: "whitespace", text: " " }], text: "" } },
		});
	});
});

function emptyTreePayload(location: JSONValue = [0, 0, 0, 0]): string {
	return JSON.stringify({ body: { body: [], location, type: "Block" }, location, type: "Root" });
}

describe("materialization", () => {
	it.for(Object.keys(rawCst))("should materialize recorded source %#", (source) => {
		expect.assertions(1);

		expect(materializeCst({ json: rawTree(source, "cst"), source })).toStrictEqual({
			ok: true,
			root: cstTree(source),
		});
	});

	it.for([null, [], [0, 0, 0], [0, 0, 0, "x"]])(
		"should reject invalid locations %#",
		(location) => {
			expect.assertions(1);

			expect(() => materializeCst({ json: emptyTreePayload(location), source: "" })).toThrow(
				"invalid CST location",
			);
		},
	);

	it.for(["null", "[]", "{}", '{"type":"Number"}'])(
		"should reject an invalid root %s",
		(json) => {
			expect.assertions(1);

			expect(() => materializeCst({ json, source: "" })).toThrow("unrecognized CST shape");
		},
	);

	it.for([
		{ source: " \t\r\f\v", trivia: [{ kind: "whitespace", text: " \t\r\f\v" }] },
		{ source: "-- last comment", trivia: [{ kind: "comment", text: "-- last comment" }] },
		{
			source: "--[[]]--[[]]",
			trivia: [
				{ kind: "blockComment", text: "--[[]]" },
				{ kind: "blockComment", text: "--[[]]" },
			],
		},
		{
			source: "--[=[first\nsecond]=]\n",
			trivia: [
				{ kind: "blockComment", text: "--[=[first\nsecond]=]" },
				{ kind: "whitespace", text: "\n" },
			],
		},
	] satisfies Array<{ source: string; trivia: Array<Trivia> }>)(
		"should retain a trivia-only source $source",
		({ source, trivia }) => {
			expect.assertions(1);

			const result = materializeCst({ json: emptyTreePayload(), source });
			assert(result.ok);

			expect(result.root.eof).toStrictEqual({
				leading: trivia,
				origin: {
					beginColumn: source.slice(source.lastIndexOf("\n") + 1).length + 1,
					beginLine: source.split("\n").length,
					endColumn: source.slice(source.lastIndexOf("\n") + 1).length + 1,
					endLine: source.split("\n").length,
				},
				text: "",
				trailing: [],
			});
		},
	);

	it.for([
		{
			error: 'bytes "bad" between the start of the file and token "" at 1:9 are not whitespace or a comment',
			source: "bad tail",
		},
		{
			error: 'bytes "oops" between the start of the file and token "" at 1:5 are not whitespace or a comment',
			source: "oops",
		},
		{
			error: 'bytes "--[[unterminated" between the start of the file and token "" at 1:17 are not whitespace or a comment',
			source: "--[[unterminated",
		},
	])("should diagnose the first invalid trivia run $source", ({ error, source }) => {
		expect.assertions(1);

		expect(materializeCst({ json: emptyTreePayload(), source })).toStrictEqual({
			errors: [error],
			ok: false,
		});
	});
});
