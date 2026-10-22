import { describe, expect, it, vi } from "vitest";

import { numberNode } from "#test/helpers/unit/cst";
import { cstTree } from "#test/helpers/unit/trees";
import {
	forEachCstNode,
	forEachToken,
	isCstNode,
	isRecord,
	someCstNode,
	tokenBounds,
	walkCst,
} from "./cst.ts";
import type { CstNode, Token } from "./cst.ts";

describe(someCstNode, () => {
	it("should stop after the first matching node", () => {
		expect.assertions(2);

		const first = numberNode();
		const visited: Array<CstNode> = [];
		const isFound = someCstNode([first, numberNode()], (node) => {
			visited.push(node);
			return node === first;
		});

		expect(isFound).toBeTrue();
		expect(visited).toStrictEqual([first]);
	});

	it("should return false after checking every unmatched node", () => {
		expect.assertions(2);

		const nodes = [numberNode(), numberNode()];
		const visited: Array<CstNode> = [];
		const isFound = someCstNode(nodes, (node) => {
			visited.push(node);
			return false;
		});

		expect(isFound).toBeFalse();
		expect(visited).toStrictEqual(nodes);
	});
});

describe(walkCst, () => {
	it("should skip a claimed node's tokens", () => {
		expect.assertions(1);

		const onToken = vi.fn<() => void>();
		walkCst(numberNode(), { onNode: () => true, onToken });

		expect(onToken).not.toHaveBeenCalled();
	});
});

describe("cST node classification", () => {
	it.for([
		{ node: false, record: false, value: null },
		{ node: false, record: false, value: 1 },
		{ node: false, record: false, value: [] },
		{ node: false, record: true, value: {} },
		{ node: false, record: true, value: { type: 0 } },
		{ node: false, record: true, value: { type: "unknown" } },
		{ node: true, record: true, value: { type: "Number" } },
	])("should classify tree value %#", ({ node, record, value }) => {
		expect.assertions(2);

		expect(isRecord(value)).toBe(record);
		expect(isCstNode(value)).toBe(node);
	});
});

describe("cST traversal", () => {
	it("should enumerate nodes and bounding tokens in lexical order", () => {
		expect.assertions(4);

		const root = cstTree("return 1\n");
		const nodes: Array<string> = [];
		const tokens: Array<Token> = [];
		forEachCstNode(root, (node) => {
			nodes.push(node.type);
		});
		forEachToken(root, (token) => {
			tokens.push(token);
		});

		expect(nodes).toStrictEqual(["Root", "Block", "Return", "Number"]);
		expect(tokens.map(({ text }) => text)).toStrictEqual(["return", "1", ""]);
		expect(tokenBounds(root)).toStrictEqual({ first: tokens[0]!, last: tokens[2]! });
		expect(tokenBounds({ body: [], location: root.location, type: "Block" })).toBeUndefined();
	});

	it("should enter before children and exit after them while respecting skipped slots", () => {
		expect.assertions(1);

		const events: Array<string> = [];
		walkCst(cstTree("return 1\n"), {
			onExit: ({ type }) => {
				events.push(`exit ${type}`);
			},
			onNode: ({ type }) => {
				events.push(`enter ${type}`);
				return false;
			},
			skipSlot: (_node, slot) => slot === "values",
		});

		expect(events).toStrictEqual([
			"enter Root",
			"enter Block",
			"enter Return",
			"exit Return",
			"exit Block",
			"exit Root",
		]);
	});

	it("should reject a malformed child slot with its node kind and slot name", () => {
		expect.assertions(1);

		const number = numberNode();
		Reflect.set(number, "token", 7);

		expect(() => {
			walkCst(number, {});
		}).toThrow("Number.token holds no node, token, or list");
	});
});
