import { loadLuauParser } from "@isentinel/luau-ast";
import type { LuauParser } from "@isentinel/luau-ast";

import { assert, describe, expect, it } from "vitest";

import ast from "../fixtures/trees/ast.json" with { type: "json" };
import cst from "../fixtures/trees/cst.json" with { type: "json" };
import rawAst from "../fixtures/trees/raw-ast.json" with { type: "json" };
import rawCst from "../fixtures/trees/raw-cst.json" with { type: "json" };

type Parse = (parser: LuauParser, source: string) => unknown;

function parseAst(parser: LuauParser, source: string) {
	return parser.parse(source);
}

function parseCst(parser: LuauParser, source: string) {
	return parser.parseCst({ fileName: "fixture.luau", source });
}

function bySource(sources: ReadonlyArray<string>, read: (source: string) => unknown) {
	return Object.fromEntries(sources.map((source) => [source, read(source)]));
}

function replayPayloads(payloads: Readonly<Record<string, string>>, parse: Parse) {
	const live = loadLuauParser();
	const sources = Object.keys(payloads);
	return {
		frozen: bySource(sources, (source) => {
			const payload = payloads[source]!;
			const parser = loadLuauParser({
				injectCstFault: () => {},
				parseToCstJson: () => payload,
				parseToJson: () => payload,
			});
			return parse(parser, source);
		}),
		live: bySource(sources, (source) => parse(live, source)),
	};
}

describe("unit tree fixtures", () => {
	it.for([
		{ kind: "AST", parse: parseAst, payloads: rawAst },
		{ kind: "CST", parse: parseCst, payloads: rawCst },
	])("should hold the raw $kind payloads the backend emits", ({ parse, payloads }) => {
		expect.assertions(1);

		const { frozen, live } = replayPayloads(payloads, parse);

		expect(frozen).toStrictEqual(live);
	});

	it("should hold the AST roots the parser returns", () => {
		expect.assertions(1);

		const parser = loadLuauParser();

		const roots = bySource(Object.keys(ast), (source) => {
			const result = parser.parse(source);
			assert(result.ok, source);
			return result.root;
		});

		expect(roots).toStrictEqual(ast);
	});

	it("should hold the CST roots the parser returns", () => {
		expect.assertions(1);

		const parser = loadLuauParser();

		const roots = bySource(Object.keys(cst), (source) => {
			const result = parseCst(parser, source);
			assert(result.ok, source);
			return result.root;
		});

		expect(roots).toStrictEqual(cst);
	});
});
