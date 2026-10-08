import { describe, expect, it } from "vitest";

import type { AstExprBinary, AstExprConstantNumber, AstStatBlock, LuauSpan } from "./ast-types.ts";
import { visitBlock, visitExpression, visitStatement } from "./visit.ts";

function makeTree() {
	const location = { beginColumn: 1, beginLine: 1, endColumn: 2, endLine: 1 } satisfies LuauSpan;
	const left = {
		location,
		type: "AstExprConstantNumber",
		value: 1,
	} satisfies AstExprConstantNumber;
	const right = {
		location,
		type: "AstExprConstantNumber",
		value: 2,
	} satisfies AstExprConstantNumber;
	const expression = {
		left,
		location,
		op: "Add",
		right,
		type: "AstExprBinary",
	} satisfies AstExprBinary;
	const block = {
		body: [{ list: [expression], location, type: "AstStatReturn" }],
		hasEnd: false,
		location,
		type: "AstStatBlock",
	} satisfies AstStatBlock;
	return { block, expression };
}

describe(visitExpression, () => {
	it("should visit operands in source order before leaving their parent", () => {
		expect.assertions(1);

		const { expression } = makeTree();
		const events: Array<number | string> = [];
		visitExpression(expression, {
			visitExprBinary: () => {
				events.push("binary");
				return true;
			},
			visitExprConstantNumber: (node) => {
				events.push(node.value);
				return true;
			},
			visitExprEnd: (node) => {
				events.push(node.type);
			},
		});

		expect(events).toStrictEqual([
			"binary",
			1,
			"AstExprConstantNumber",
			2,
			"AstExprConstantNumber",
			"AstExprBinary",
		]);
	});

	it("should suppress callbacks and descent when the general visitor declines", () => {
		expect.assertions(1);

		const { expression } = makeTree();
		const events: Array<string> = [];
		visitExpression(expression, {
			visitExpr: () => false,
			visitExprBinary: () => {
				events.push("binary");
				return true;
			},
			visitExprEnd: () => {
				events.push("end");
			},
		});

		expect(events).toStrictEqual([]);
	});

	it("should leave a declined binary without visiting its operands", () => {
		expect.assertions(1);

		const { expression } = makeTree();
		const events: Array<string> = [];
		visitExpression(expression, {
			visitExprBinary: () => false,
			visitExprConstantNumber: () => {
				events.push("number");
				return true;
			},
			visitExprEnd: (node) => {
				events.push(node.type);
			},
		});

		expect(events).toStrictEqual(["AstExprBinary"]);
	});
});

describe(visitBlock, () => {
	it("should leave the block after all statement expressions", () => {
		expect.assertions(1);

		const { block } = makeTree();
		const events: Array<number | string> = [];
		visitBlock(block, {
			visitExprConstantNumber: (node) => {
				events.push(node.value);
				return true;
			},
			visitStatBlockEnd: () => {
				events.push("end");
			},
		});

		expect(events).toStrictEqual([1, 2, "end"]);
	});
});

describe(visitStatement, () => {
	it("should skip a declined return statement's expressions", () => {
		expect.assertions(1);

		const { block } = makeTree();
		const events: Array<string> = [];
		visitStatement(block.body[0]!, {
			visitExpr: (node) => {
				events.push(node.type);
				return true;
			},
			visitStatReturn: () => false,
		});

		expect(events).toStrictEqual([]);
	});
});
