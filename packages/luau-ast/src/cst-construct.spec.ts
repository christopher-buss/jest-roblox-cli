import { describe, expect, it } from "vitest";

import type { LuauSpan } from "./ast-types.ts";
import { constructExpression, constructStatements } from "./cst-construct.ts";
import type { CstParseResult } from "./cst-materialize.ts";
import type { CstNumber, CstRoot, Token } from "./cst.ts";
import type { CstParseOptions } from "./parser.ts";

function makeSnippet() {
	const location = { beginColumn: 1, beginLine: 1, endColumn: 2, endLine: 1 } satisfies LuauSpan;
	const token = { leading: [], origin: location, text: "1", trailing: [] } satisfies Token;
	const expression = { location, token, type: "Number" } satisfies CstNumber;
	const keyword = { leading: [], origin: location, text: "return", trailing: [] } satisfies Token;
	const eof = { leading: [], origin: location, text: "", trailing: [] } satisfies Token;
	const root = {
		body: {
			body: [{ keyword, location, type: "Return", values: [{ node: expression }] }],
			location,
			type: "Block",
		},
		eof,
		location,
		type: "Root",
	} satisfies CstRoot;
	const requests: Array<CstParseOptions> = [];
	function parse(request: CstParseOptions): CstParseResult {
		requests.push(request);
		return { ok: true, root };
	}

	return { expression, keyword, parse, requests, root, token };
}

describe(constructExpression, () => {
	it("should parse one return value and detach only its origins", () => {
		expect.assertions(4);

		const { expression, keyword, parse, requests, token } = makeSnippet();
		const result = constructExpression(parse, "1");

		expect(requests).toStrictEqual([{ fileName: "snippet", source: "return 1" }]);
		expect(result).toBe(expression);
		expect(token.origin).toBeUndefined();
		expect(keyword.origin).toBeDefined();
	});

	it("should reject a snippet returning more than one expression", () => {
		expect.assertions(1);

		const { expression, parse, root } = makeSnippet();
		root.body.body[0]!.values.push({ node: expression });

		expect(() => constructExpression(parse, "1, 1")).toThrow("snippet is not one expression");
	});

	it("should preserve parser diagnostics when a snippet is invalid", () => {
		expect.assertions(1);

		function parse(): CstParseResult {
			return { errors: ["expected expression", "unexpected token"], ok: false };
		}

		expect(() => constructExpression(parse, "=")).toThrow(
			"snippet does not parse: expected expression; unexpected token",
		);
	});
});

describe(constructStatements, () => {
	it("should detach block tokens while leaving end-of-file trivia outside the snippet", () => {
		expect.assertions(5);

		const { keyword, parse, requests, root, token } = makeSnippet();
		const result = constructStatements(parse, "return 1");

		expect(requests).toStrictEqual([{ fileName: "snippet", source: "return 1" }]);
		expect(result).toBe(root.body);
		expect(keyword.origin).toBeUndefined();
		expect(token.origin).toBeUndefined();
		expect(root.eof.origin).toBeDefined();
	});
});
