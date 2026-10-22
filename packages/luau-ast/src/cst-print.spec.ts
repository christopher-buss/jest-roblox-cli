import { fromPartial } from "@total-typescript/shoehorn";

import { assert, describe, expect, it } from "vitest";

import { numberNode } from "#test/helpers/unit/cst";
import { cstTree } from "#test/helpers/unit/trees";
import cst from "../test/fixtures/trees/cst.json" with { type: "json" };
import type { CstEdits, Replacement } from "./cst-edit.ts";
import { printCst, printCstMapped } from "./cst-print.ts";
import type { CstNode } from "./cst.ts";
import type { SourceBytes } from "./source-bytes.ts";

describe(printCst, () => {
	it("should print the supplied token spelling and trivia", () => {
		expect.assertions(1);

		const root = numberNode();
		root.token.leading.push({ kind: "comment", text: "-- value\n" });
		root.token.trailing.push({ kind: "whitespace", text: "\n" });

		expect(printCst(root)).toBe("-- value\n1\n");
	});
});

function editFor(target: CstNode, replacement: Replacement): CstEdits {
	return fromPartial<CstEdits>({
		callerFor: () => {},
		replacementFor: (node: CstNode) => (node === target ? replacement : undefined),
	});
}

describe("recorded CST output", () => {
	it.for(Object.keys(cst))("should preserve every source byte in fixture %#", (source) => {
		expect.assertions(1);

		expect(printCst(cstTree(source))).toBe(source);
	});

	it.for([
		{
			expected: "-- header\nreturn 2\n",
			index: 0,
			preserveLeading: true,
			source: "-- header\nlocal boilerplate = 1\nreturn 2\n",
		},
		{
			expected: "--[[c]] \nlocal y = 2\n",
			index: 0,
			preserveLeading: true,
			source: "--[[c]] local x = 1\nlocal y = 2\n",
		},
		{
			expected: "local y = 2\n",
			index: 1,
			preserveLeading: true,
			source: "local y = 2\nlocal x = 1",
		},
		{
			expected: " -- keep\nlocal y = 2\n",
			index: 0,
			preserveLeading: true,
			source: "local x = 1 -- keep\nlocal y = 2\n",
		},
		{
			expected: "local a = 1\nreturn a\n",
			index: 1,
			preserveLeading: false,
			source: "local a = 1\n-- about b\nlocal b = 2\nreturn a\n",
		},
		{
			expected: "return 2\n",
			index: 0,
			preserveLeading: true,
			source: "local a = 1\nreturn 2\n",
		},
		{
			expected: "local a = 1 -- one\nreturn a\n",
			index: 1,
			preserveLeading: true,
			source: "local a = 1 -- one\n\tlocal b = 2\nreturn a\n",
		},
	])(
		"should apply removal policy to fixture %#",
		({ expected, index, preserveLeading, source }) => {
			expect.assertions(1);

			const root = cstTree(source);
			const target = root.body.body[index]!;

			expect(printCst(root, editFor(target, { preserveLeading, remove: true }))).toBe(
				expected,
			);
		},
	);

	it.for([
		{
			expected: "do\n\t-- c\n\tprint(x)\nend\n",
			source: "do\n\t-- c\n\tlocal x = 1\n\tprint(x)\nend\n",
		},
		{ expected: "do  end\n", source: "do local x = 1 end\n" },
		{
			expected: "do\n\n\t-- about b\n\treturn 1\nend\n",
			source: "do\n\n\t-- about b\n\tlocal b = 2\n\treturn 1\nend\n",
		},
	])("should remove nested statements with their line indentation %#", ({ expected, source }) => {
		expect.assertions(1);

		const root = cstTree(source);
		const block = root.body.body[0]!;
		assert(block.type === "Do");

		expect(
			printCst(root, editFor(block.body.body[0]!, { preserveLeading: true, remove: true })),
		).toBe(expected);
	});

	it.for([
		{
			expected: "local a = 1\n\nlocal b = a -- call\nreturn b\n",
			index: 1,
			replacement: { text: "local b = a" },
			source: "local a = 1\n\nlocal b = f(a) -- call\nreturn b\n",
		},
		{
			expected: "return 1",
			index: 0,
			replacement: { preserveLeading: false, preserveTrailing: false, text: "return 1" },
			source: "-- above\nlocal dep = f(1) -- import\n",
		},
		{
			expected: "f()\n  ;(get()).x = 1\n",
			index: 1,
			replacement: { text: "  (get()).x = 1" },
			source: "f()\n_G.cfg.x = 1\n",
		},
		{
			expected: "(get()).x = 1\n",
			index: 0,
			replacement: { text: "(get()).x = 1" },
			source: "_G.cfg.x = 1\n",
		},
	])(
		"should print replacement text with its requested trivia %#",
		({ expected, index, replacement, source }) => {
			expect.assertions(1);

			const root = cstTree(source);

			expect(printCst(root, editFor(root.body.body[index]!, replacement))).toBe(expected);
		},
	);

	it("should print a replacement subtree with the target's outer trivia", () => {
		expect.assertions(1);

		const root = cstTree("-- header\nlocal boilerplate = 1\nreturn 2\n");
		const replacement = numberNode();
		replacement.token.text = "replacement";

		expect(printCst(root, editFor(root.body.body[0]!, replacement))).toBe(
			"-- header\nreplacement\nreturn 2\n",
		);
	});

	it("should reject replacing a node with no tokens", () => {
		expect.assertions(1);

		const target: CstNode = { body: [], location: numberNode().location, type: "Block" };

		expect(() => printCst(target, editFor(target, { text: "text" }))).toThrow(
			"a replaced node has no tokens",
		);
	});
});

function sourceIndex() {
	const columns: Array<[number, number]> = [];
	const source = fromPartial<SourceBytes>({
		toUtf16Column: (line: number, column: number) => {
			columns.push([line, column]);
			return column + 10;
		},
	});
	return { columns, source };
}

describe(printCstMapped, () => {
	it("should map each nonempty token through the supplied byte-column converter", () => {
		expect.assertions(2);

		const { columns, source } = sourceIndex();
		const root = cstTree("return 1\n");
		const statement = root.body.body[0]!;
		assert(statement.type === "Return");
		const number = statement.values[0]!.node;
		assert(number.type === "Number");
		number.token.generatedBy = "number-rule";

		expect(printCstMapped(root, { source })).toStrictEqual({
			code: "return 1\n",
			segments: [
				{ generated: { column: 0, line: 1 }, original: { column: 10, line: 1 } },
				{
					generated: { column: 7, line: 1 },
					generatedBy: "number-rule",
					original: { column: 17, line: 1 },
				},
			],
		});
		expect(columns).toStrictEqual([
			[1, 1],
			[1, 8],
		]);
	});

	it.for([
		{ attribution: { generatedBy: "rule" }, caller: "rule" },
		{ attribution: {}, caller: undefined },
	])("should map multiline replacement text with caller $caller", ({ attribution, caller }) => {
		expect.assertions(1);

		const { source } = sourceIndex();
		const root = cstTree("return 1\n");
		const edits = editFor(root.body.body[0]!, { text: " \nreplacement\nmore" });
		edits.callerFor = () => caller;

		expect(printCstMapped(root, { edits, source })).toStrictEqual({
			code: " \nreplacement\nmore\n",
			segments: [
				{
					...attribution,
					generated: { column: 0, line: 2 },
					original: { column: 10, line: 1 },
				},
			],
		});
	});

	it("should omit mappings for tokens without source origins and replacements", () => {
		expect.assertions(2);

		const { source } = sourceIndex();
		const root = cstTree("return 1\n");
		const statement = root.body.body[0]!;
		assert(statement.type === "Return");
		delete statement.keyword.origin;
		const number = statement.values[0]!.node;
		assert(number.type === "Number");
		delete number.token.origin;

		expect(printCstMapped(root, { source }).segments).toStrictEqual([]);
		expect(
			printCstMapped(root, { edits: editFor(statement, { text: "replacement" }), source })
				.segments,
		).toStrictEqual([]);
	});
});

describe("statement replacement boundaries", () => {
	it.for([
		{ expected: "  \n(get()).x = 1\n", text: "  " },
		{ expected: "f();\n(get()).x = 1\n", text: "f();" },
		{ expected: "f();  \n(get()).x = 1\n", text: "f();  " },
	])("should separate a statement following replacement $text", ({ expected, text }) => {
		expect.assertions(1);

		const root = cstTree("f()\n_G.cfg.x = 1\n");
		const replacements = new Map<CstNode, Replacement>([
			[root.body.body[0]!, { text }],
			[root.body.body[1]!, { text: "(get()).x = 1" }],
		]);
		const edits = fromPartial<CstEdits>({
			replacementFor: (node: CstNode) => replacements.get(node),
		});

		expect(printCst(root, edits)).toBe(expected);
	});
});

function terminatedCall() {
	const root = cstTree("f()\nlocal y = 1\n_G.cfg.x = 1\n");
	const first = root.body.body[0]!;
	assert(first.type === "ExprStat" && first.expr.type === "Call");
	const close = first.expr.close!;
	first.semicolon = { leading: [], text: ";", trailing: close.trailing };
	close.trailing = [];
	return root;
}

describe("printer state across empty tokens", () => {
	it("should retain the last nonempty token before a parenthesized statement", () => {
		expect.assertions(1);

		const root = terminatedCall();
		const middle = root.body.body[1]!;
		assert(middle.type === "Local");
		const value = middle.values[0]!.node;
		assert(value.type === "Number");
		for (const token of [
			middle.keyword,
			middle.variables[0]!.node.name,
			middle.equals!,
			value.token,
		]) {
			token.text = "";
		}

		expect(printCst(root, editFor(root.body.body[2]!, { text: "(get()).x = 1" }))).toBe(
			"f();\n   \n(get()).x = 1\n",
		);
	});

	it("should retain a semicolon across an empty text replacement", () => {
		expect.assertions(1);

		const root = terminatedCall();
		const replacements = new Map<CstNode, Replacement>([
			[root.body.body[1]!, { text: "" }],
			[root.body.body[2]!, { text: "(get()).x = 1" }],
		]);
		const edits = fromPartial<CstEdits>({
			replacementFor: (node: CstNode) => replacements.get(node),
		});

		expect(printCst(root, edits)).toBe("f();\n\n(get()).x = 1\n");
	});

	it("should propagate a constructed block's printed predecessor to its enclosing statement", () => {
		expect.assertions(1);

		const root = cstTree("f()\n_G.cfg.x = 1\n");
		const replacement = cstTree("local x = 1\n").body;
		const replacements = new Map<CstNode, Replacement>([
			[root.body.body[0]!, replacement],
			[root.body.body[1]!, { text: "(get()).x = 1" }],
		]);
		const edits = fromPartial<CstEdits>({
			replacementFor: (node: CstNode) => replacements.get(node),
		});

		expect(printCst(root, edits)).toBe("local x = 1\n\n;(get()).x = 1\n");
	});

	it("should preserve whitespace around replacement text inside an already-started statement", () => {
		expect.assertions(1);

		const root = cstTree("return 1\n");
		const returned = root.body.body[0]!;
		assert(returned.type === "Return");

		expect(printCst(root, editFor(returned.values[0]!.node, { text: " 2 " }))).toBe(
			"return  2 \n",
		);
	});

	it("should omit source mappings for empty replacement text", () => {
		expect.assertions(1);

		const root = cstTree("return 1\n");
		const { source } = sourceIndex();

		expect(
			printCstMapped(root, { edits: editFor(root.body.body[0]!, { text: "" }), source }),
		).toStrictEqual({ code: "\n", segments: [] });
	});

	it.for([
		{
			expected: "--[[keep\ncomment]]\nreturn 2\n",
			index: 0,
			source: "local x = 1--[[keep\ncomment]]\nreturn 2\n",
		},
		{ expected: "f() \n", index: 1, source: "f() local x = 1\n" },
	])(
		"should preserve comments and line endings around removed statements %#",
		({ expected, index, source }) => {
			expect.assertions(1);

			const root = cstTree(source);

			expect(
				printCst(
					root,
					editFor(root.body.body[index]!, { preserveLeading: true, remove: true }),
				),
			).toBe(expected);
		},
	);
});
