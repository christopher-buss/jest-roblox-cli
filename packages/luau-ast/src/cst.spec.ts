import { describe, expect, it, vi } from "vitest";

import { numberNode } from "#test/helpers/unit/cst";
import { someCstNode, walkCst } from "./cst.ts";
import type { CstNode } from "./cst.ts";

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
