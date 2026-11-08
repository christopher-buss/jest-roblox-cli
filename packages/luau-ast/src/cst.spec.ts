import { fromAny } from "@total-typescript/shoehorn";

import { assert, describe, expect, it, vi } from "vitest";

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

const UNION_AND_CALL = "type T = A | B\nlocal x = f(1, 2)\n";

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

	it("should search the nodes of punctuated entries and stop inside them", () => {
		expect.assertions(2);

		const visited: Array<string> = [];
		const isFound = someCstNode(cstTree(UNION_AND_CALL), (node) => {
			visited.push(node.type);
			return node.type === "Number";
		});

		expect(isFound).toBeTrue();
		expect(visited).toStrictEqual([
			"Root",
			"Block",
			"TypeAlias",
			"TypeUnion",
			"TypeReference",
			"TypeReference",
			"Local",
			"LocalDecl",
			"Call",
			"Global",
			"Number",
		]);
	});

	it("should name a slot that holds no node, token, or list", () => {
		expect.assertions(1);

		const number = numberNode();
		Reflect.set(number, "token", "1");

		expect(() => someCstNode(number, () => false)).toThrow(
			"Number.token holds no node, token, or list",
		);
	});
});

describe(walkCst, () => {
	it("should skip a claimed node's tokens", () => {
		expect.assertions(2);

		const onToken = vi.fn<() => void>();
		const onExit = vi.fn<() => void>();
		walkCst(numberNode(), { onExit, onNode: () => true, onToken });

		expect(onToken).not.toHaveBeenCalled();
		expect(onExit).not.toHaveBeenCalled();
	});

	it("should visit a union member's separator before it and a call argument's after it", () => {
		expect.assertions(1);

		const tokens: Array<string> = [];
		forEachToken(cstTree(UNION_AND_CALL), ({ text }) => {
			tokens.push(text);
		});

		expect(tokens).toStrictEqual([
			"type",
			"T",
			"=",
			"A",
			"|",
			"B",
			"local",
			"x",
			"=",
			"f",
			"(",
			"1",
			",",
			"2",
			")",
			"",
		]);
	});

	it("should reject a node of an unknown kind", () => {
		expect.assertions(1);

		expect(() => {
			walkCst(fromAny({ type: "Mystery" }), {});
		}).toThrow("Mystery is not a node kind");
	});

	it("should reject a slot holding null", () => {
		expect.assertions(1);

		const number = numberNode();
		Reflect.set(number, "token", null);

		expect(() => {
			walkCst(number, {});
		}).toThrow("Number.token holds no node, token, or list");
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

	it("should bound a node past empty edge slots and from both ends of a list", () => {
		expect.assertions(2);

		const root = cstTree(UNION_AND_CALL);
		const [alias, local] = root.body.body;

		expect(tokenBounds(root.body)).toStrictEqual({
			first: tokenBounds(alias!)!.first,
			last: tokenBounds(local!)!.last,
		});
		expect([tokenBounds(alias!)!.first.text, tokenBounds(local!)!.last.text]).toStrictEqual([
			"type",
			")",
		]);
	});

	it("should read a union member's separator before the member at either edge", () => {
		expect.assertions(2);

		const union = cstTree(UNION_AND_CALL).body.body[0]!;
		assert(union.type === "TypeAlias" && union.value.type === "TypeUnion", "a union alias");
		const { items } = union.value;
		items[0]!.separator = { leading: [], text: "|", trailing: [] };

		expect(tokenBounds(union.value)!.first).toBe(items[0]!.separator);
		expect(tokenBounds(union.value)!.last.text).toBe("B");
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

	it.for([
		["an empty object", {}],
		["a token with a numeric text", { leading: [], text: 7, trailing: [] }],
		["a token with no trivia", { text: "1" }],
		["a node of an unknown kind", { type: "Mystery" }],
		["a bare punctuated entry", { node: numberNode() }],
	])("should reject a slot holding %s through every walk", ([, value]) => {
		expect.assertions(5);

		const number = numberNode();
		Reflect.set(number, "token", value);
		const message = "Number.token holds no node, token, or list";

		expect(() => {
			walkCst(number, { onToken: () => {} });
		}).toThrow(message);
		expect(() => someCstNode(number, () => false)).toThrow(message);
		expect(() => {
			forEachToken(number, () => {});
		}).toThrow(message);
		expect(() => {
			forEachCstNode(number, () => {});
		}).toThrow(message);
		expect(() => tokenBounds(number)).toThrow(message);
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
