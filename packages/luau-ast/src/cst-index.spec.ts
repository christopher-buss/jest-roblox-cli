import { assert, describe, expect, it } from "vitest";

import { numberNode } from "#test/helpers/unit/cst";
import { cstTree } from "#test/helpers/unit/trees";
import { indexCst } from "./cst-index.ts";
import type { CstBlock, CstNode, CstWalker } from "./cst.ts";

const NESTED = "local x = 1\ndo\n\tlocal x = 2\n\tprint(x)\nend\nreturn x + x\n";

function walkEvents(walk: (walker: Required<Pick<CstWalker, "onExit" | "onNode">>) => void) {
	const events: Array<string> = [];
	walk({
		onExit: ({ type }) => {
			events.push(`exit ${type}`);
		},
		onNode: ({ type }) => {
			events.push(`enter ${type}`);
			return type === "Local";
		},
	});
	return events;
}

describe(indexCst, () => {
	it("should list nodes in pre-order and the tree's own tokens", () => {
		expect.assertions(2);

		const root = cstTree("return 1\n");
		const statement = root.body.body[0]!;
		assert(statement.type === "Return", "the fixture returns");
		const index = indexCst(root);
		index.tokens[0]!.text = "exit";

		expect(index.nodes).toStrictEqual([root, root.body, statement, statement.values[0]!.node]);
		expect(index.tokens.map(({ text }) => text)).toStrictEqual(["exit", "1", ""]);
	});

	it("should bound each node by its first and last token", () => {
		expect.assertions(2);

		const root = cstTree(NESTED);
		const index = indexCst(root);
		const empty: CstBlock = { body: [], location: root.location, type: "Block" };

		function boundTexts(node: CstNode): [string, string] {
			const { first, last } = index.boundsOf(node)!;
			return [first.text, last.text];
		}

		expect(root.body.body.map(boundTexts)).toStrictEqual([
			["local", "1"],
			["do", "end"],
			["return", "x"],
		]);
		expect(indexCst(empty).boundsOf(empty)).toBeUndefined();
	});

	it("should give each node the token positions it fills", () => {
		expect.assertions(2);

		const root = cstTree(NESTED);
		const index = indexCst(root);
		const empty: CstBlock = { body: [], location: root.location, type: "Block" };

		expect(root.body.body.map((node) => index.tokenRangeOf(node))).toStrictEqual([
			{ end: 4, start: 0 },
			{ end: 14, start: 4 },
			{ end: 18, start: 14 },
		]);
		expect(indexCst(empty).tokenRangeOf(empty)).toStrictEqual({ end: 0, start: 0 });
	});

	it("should list the nodes of one kind in pre-order", () => {
		expect.assertions(3);

		const index = indexCst(cstTree(NESTED));

		expect(
			index.ofKind("Local").map(({ variables }) => variables[0]!.node.name.text),
		).toStrictEqual(["x", "x"]);
		expect(index.ofKind("Local")).toBe(index.ofKind("Local"));
		expect(index.ofKind("While")).toStrictEqual([]);
	});

	it("should give each node its ordinal and parent", () => {
		expect.assertions(4);

		const root = cstTree("return 1\n");
		const index = indexCst(root);
		const statement = root.body.body[0]!;

		expect(index.ordinalOf(statement)).toBe(2);
		expect(index.ordinalOf(numberNode())).toBeUndefined();
		expect(index.parentOf(statement)).toBe(root.body);
		expect(index.parentOf(root)).toBeUndefined();
	});

	it("should map each node but the root to its parent, built once", () => {
		expect.assertions(2);

		const root = cstTree(NESTED);
		const index = indexCst(root);
		const expected = new Map(
			index.nodes.slice(1).map((node) => [node, index.parentOf(node)] as const),
		);

		expect(index.parentMap()).toStrictEqual(expected);
		expect(index.parentMap()).toBe(index.parentMap());
	});

	it("should name a node the index does not hold", () => {
		expect.assertions(4);

		const index = indexCst(cstTree("return 1\n"));
		const foreign = numberNode();

		expect(() => index.parentOf(foreign)).toThrow("the index holds no Number at 1:1");
		expect(() => index.boundsOf(foreign)).toThrow("the index holds no Number at 1:1");
		expect(() => index.tokenRangeOf(foreign)).toThrow("the index holds no Number at 1:1");
		expect(() => {
			index.walk(foreign, {});
		}).toThrow("the index holds no Number at 1:1");
	});

	it("should walk a subtree in pre-order, skipping claimed nodes", () => {
		expect.assertions(1);

		const root = cstTree(NESTED);
		const index = indexCst(root);
		const block = root.body.body[1]!;

		expect(
			walkEvents((walker) => {
				index.walk(block, walker);
			}),
		).toStrictEqual([
			"enter Do",
			"enter Block",
			"enter Local",
			"enter ExprStat",
			"enter Call",
			"enter Global",
			"exit Global",
			"enter LocalRef",
			"exit LocalRef",
			"exit Call",
			"exit ExprStat",
			"exit Block",
			"exit Do",
		]);
	});
});
