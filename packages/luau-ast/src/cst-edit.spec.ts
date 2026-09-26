import { assert, describe, expect, it } from "vitest";

import { createCstEdits, renameBinding, renameBindings } from "./cst-edit.ts";
import { printCst, printCstMapped } from "./cst-print.ts";
import type { CstPosition, CstSourcemapSegment } from "./cst-print.ts";
import { forEachCstNode } from "./cst.ts";
import type { CstIndexName, CstLocalDeclaration, CstNode, CstRoot } from "./cst.ts";
import { loadLuauParser } from "./parser.ts";
import { indexSourceBytes } from "./source-bytes.ts";

function parseCst(source: string): CstRoot {
	const result = loadLuauParser().parseCst({ fileName: "test.luau", source });
	if (!result.ok) {
		throw new Error(result.errors.join("\n"));
	}

	return result.root;
}

/** The segment whose generated position is `position`. */
function segmentAt(
	segments: Array<CstSourcemapSegment>,
	position: CstPosition,
): CstSourcemapSegment {
	const segment = segments.find((candidate) => {
		return (
			candidate.generated.line === position.line &&
			candidate.generated.column === position.column
		);
	});
	if (segment === undefined) {
		throw new Error(`no segment at ${String(position.line)}:${String(position.column)}`);
	}

	return segment;
}

/** The first node in source order that `matches`. */
function findNode<Found extends CstNode>(
	root: CstNode,
	matches: (node: CstNode) => node is Found,
): Found {
	let found: Found | undefined;
	forEachCstNode(root, (node) => {
		if (found === undefined && matches(node)) {
			found = node;
		}
	});

	if (found === undefined) {
		throw new Error("no node matches");
	}

	return found;
}

function isKind<Kind extends CstNode["type"]>(
	node: CstNode,
	type: Kind,
): node is Extract<CstNode, { type: Kind }> {
	return node.type === type;
}

function isConfigAccess(node: CstNode): node is CstIndexName {
	return node.type === "IndexName" && node.index.text === "cfg";
}

/** The binding number of the first declaration named `name`. */
function bindingOf(root: CstRoot, name: string): number {
	return findNode(
		root,
		(node): node is CstLocalDeclaration => isKind(node, "LocalDecl") && node.name.text === name,
	).binding;
}

describe(renameBinding, () => {
	it("should rename every declaration and reference of the binding and nothing else", () => {
		expect.assertions(1);

		const root = parseCst("local x = 1\ndo\n\tlocal x = 2\n\tprint(x)\nend\nreturn x + x\n");

		renameBinding(root, { name: "a_x", binding: bindingOf(root, "x") });

		expect(printCst(root)).toBe(
			"local a_x = 1\ndo\n\tlocal x = 2\n\tprint(x)\nend\nreturn a_x + a_x\n",
		);
	});
});

describe(printCstMapped, () => {
	it("should map a renamed token to the original line and UTF-16 column past multi-byte text", () => {
		expect.assertions(1);

		// `local x` sits after a two-byte `é` and a three-byte `€`, so the
		// byte column and the UTF-16 column disagree on that line.
		const source = 'local s = "é€"; local x = 1\nreturn x\n';
		const root = parseCst(source);
		renameBinding(root, { name: "renamed", binding: bindingOf(root, "x") });

		const { code, segments } = printCstMapped(root, { source: indexSourceBytes(source) });

		const declaration = segmentAt(segments, { column: code.indexOf("renamed"), line: 1 });
		const reference = segmentAt(segments, { column: "return ".length, line: 2 });

		expect([declaration.original, reference.original]).toStrictEqual([
			{ column: source.indexOf("x = 1"), line: 1 },
			{ column: "return ".length, line: 2 },
		]);
	});

	it("should map a token after an inserted statement separator to its original position", () => {
		expect.assertions(1);

		const source = "f()\n_G.cfg.x = 1\n";
		const root = parseCst(source);
		const edits = createCstEdits();
		edits.replace({
			caller: "define",
			replacement: { text: "(true)" },
			target: findNode(root, isConfigAccess),
		});

		const { code, segments } = printCstMapped(root, {
			edits,
			source: indexSourceBytes(source),
		});

		expect({
			code,
			original: segmentAt(segments, { column: 7, line: 2 }).original,
		}).toStrictEqual({
			code: "f()\n;(true).x = 1\n",
			original: { column: 6, line: 2 },
		});
	});
});

describe(printCst, () => {
	it("should separate a printed parenthesized statement from the preceding call", () => {
		expect.assertions(1);

		const root = parseCst("f()\n_G.cfg.x = 1\n");
		const edits = createCstEdits();
		const access = findNode(root, isConfigAccess);
		edits.replace({ caller: "define", replacement: { text: "(nil)" }, target: access });

		expect(printCst(root, edits)).toBe("f()\n;(nil).x = 1\n");
	});

	it("should leave a parenthesized first statement without a separator", () => {
		expect.assertions(1);

		const root = parseCst("_G.cfg.x = 1\n");
		const edits = createCstEdits();
		const access = findNode(root, isConfigAccess);
		edits.replace({ caller: "define", replacement: { text: "(nil)" }, target: access });

		expect(printCst(root, edits)).toBe("(nil).x = 1\n");
	});

	it("should ignore a removed predecessor when separating statements", () => {
		expect.assertions(1);

		const root = parseCst("local y = 1\n_G.cfg.x = 1\n");
		const edits = createCstEdits();
		const access = findNode(root, isConfigAccess);
		edits.remove({ caller: "constants", preserveLeading: true, statement: root.body.body[0]! });
		edits.replace({ caller: "define", replacement: { text: "(nil)" }, target: access });

		expect(printCst(root, edits)).toBe("(nil).x = 1\n");
	});

	it("should separate statements that become neighbors after a removal", () => {
		expect.assertions(1);

		const root = parseCst("f()\nlocal y = 1\n_G.cfg.x = 1\n");
		const edits = createCstEdits();
		const access = findNode(root, isConfigAccess);
		edits.remove({ caller: "constants", preserveLeading: true, statement: root.body.body[1]! });
		edits.replace({ caller: "define", replacement: { text: "(nil)" }, target: access });

		expect(printCst(root, edits)).toBe("f()\n;(nil).x = 1\n");
	});

	it("should count a constructed statement block as a printed predecessor", () => {
		expect.assertions(1);

		const root = parseCst("f()\n_G.cfg.x = 1\n");
		const edits = createCstEdits();
		edits.replace({
			caller: "inline",
			replacement: loadLuauParser().constructStatements("g()"),
			target: root.body.body[0]!,
		});
		edits.replace({
			caller: "define",
			replacement: { text: "(nil)" },
			target: findNode(root, isConfigAccess),
		});

		expect(printCst(root, edits)).toBe("g()\n;(nil).x = 1\n");
	});

	it("should ignore a whitespace-only statement replacement as a predecessor", () => {
		expect.assertions(1);

		const root = parseCst("f()\n_G.cfg.x = 1\n");
		const edits = createCstEdits();
		edits.replace({
			caller: "remove-call",
			replacement: { text: "  " },
			target: root.body.body[0]!,
		});
		edits.replace({
			caller: "define",
			replacement: { text: "(nil)" },
			target: findNode(root, isConfigAccess),
		});

		expect(printCst(root, edits)).toBe("  \n(nil).x = 1\n");
	});
});

describe(renameBindings, () => {
	it("should rename each listed binding and leave the rest", () => {
		expect.assertions(1);

		const root = parseCst("local x = 1\nlocal y = x\nlocal z = y\nreturn z\n");

		renameBindings(
			root,
			new Map([
				[bindingOf(root, "x"), "a_x"],
				[bindingOf(root, "z"), "a_z"],
			]),
		);

		expect(printCst(root)).toBe("local a_x = 1\nlocal y = a_x\nlocal a_z = y\nreturn a_z\n");
	});
});

describe(createCstEdits, () => {
	it("should keep a header comment and leave no blank line when a statement is removed with leading trivia kept", () => {
		expect.assertions(1);

		const root = parseCst("-- header\nlocal boilerplate = 1\nreturn 2\n");
		const edits = createCstEdits();

		edits.remove({
			caller: "strip-boilerplate",
			preserveLeading: true,
			statement: root.body.body[0]!,
		});

		expect(printCst(root, edits)).toBe("-- header\nreturn 2\n");
	});

	it("should print replacement text between the replaced node's outer trivia", () => {
		expect.assertions(1);

		const root = parseCst("local a = 1\n\nlocal b = f(a) -- call\nreturn b\n");
		const edits = createCstEdits();

		edits.replace({
			caller: "inline",
			replacement: { text: "local b = a" },
			target: root.body.body[1]!,
		});

		expect(printCst(root, edits)).toBe("local a = 1\n\nlocal b = a -- call\nreturn b\n");
	});

	it("should remove an indented line with its indentation and keep the comment above", () => {
		expect.assertions(1);

		const root = parseCst("do\n\t-- c\n\tlocal x = 1\n\tprint(x)\nend\n");
		const edits = createCstEdits();
		const block = root.body.body[0]!;
		assert(block.type === "Do");

		edits.remove({ caller: "alias", preserveLeading: true, statement: block.body.body[0]! });

		expect(printCst(root, edits)).toBe("do\n\t-- c\n\tprint(x)\nend\n");
	});

	it("should keep the whitespace on both sides of a removed mid-line statement", () => {
		expect.assertions(1);

		const root = parseCst("do local x = 1 end\n");
		const edits = createCstEdits();
		const block = root.body.body[0]!;
		assert(block.type === "Do");

		edits.remove({ caller: "alias", preserveLeading: true, statement: block.body.body[0]! });

		expect(printCst(root, edits)).toBe("do  end\n");
	});

	it("should keep a block comment that shares the removed statement's line", () => {
		expect.assertions(1);

		const root = parseCst("--[[c]] local x = 1\nlocal y = 2\n");
		const edits = createCstEdits();

		edits.remove({ caller: "alias", preserveLeading: true, statement: root.body.body[0]! });

		expect(printCst(root, edits)).toBe("--[[c]] \nlocal y = 2\n");
	});

	it("should remove the last statement of a file that has no trailing newline", () => {
		expect.assertions(1);

		const root = parseCst("local y = 2\nlocal x = 1");
		const edits = createCstEdits();

		edits.remove({ caller: "alias", preserveLeading: true, statement: root.body.body[1]! });

		expect(printCst(root, edits)).toBe("local y = 2\n");
	});

	it("should keep a trailing comment on a removed statement's line", () => {
		expect.assertions(1);

		const root = parseCst("local x = 1 -- keep\nlocal y = 2\n");
		const edits = createCstEdits();

		edits.remove({ caller: "alias", preserveLeading: true, statement: root.body.body[0]! });

		expect(printCst(root, edits)).toBe(" -- keep\nlocal y = 2\n");
	});

	it("should drop both sides' trivia around replacement text when asked", () => {
		expect.assertions(1);

		const root = parseCst("-- above\nlocal dep = f(1) -- import\n");
		const edits = createCstEdits();

		edits.replace({
			caller: "imports",
			replacement: { preserveLeading: false, preserveTrailing: false, text: "return 1" },
			target: root.body.body[0]!,
		});

		expect(printCst(root, edits)).toBe("return 1");
	});

	it("should drop the comment above a statement removed with leading trivia dropped", () => {
		expect.assertions(1);

		const root = parseCst("local a = 1\n-- about b\nlocal b = 2\nreturn a\n");
		const edits = createCstEdits();

		edits.remove({
			caller: "strip-boilerplate",
			preserveLeading: false,
			statement: root.body.body[1]!,
		});

		expect(printCst(root, edits)).toBe("local a = 1\nreturn a\n");
	});

	it("should take the indentation with an indented statement it removes, keeping what is above", () => {
		expect.assertions(1);

		const root = parseCst("do\n\n\t-- about b\n\tlocal b = 2\n\treturn 1\nend\n");
		const edits = createCstEdits();
		const block = findNode(root, (node) => isKind(node, "Do"));

		edits.remove({ caller: "inline", preserveLeading: true, statement: block.body.body[0]! });

		expect(printCst(root, edits)).toBe("do\n\n\t-- about b\n\treturn 1\nend\n");
	});

	it("should remove a statement that opens the file, which has no leading trivia", () => {
		expect.assertions(1);

		const root = parseCst("local a = 1\nreturn 2\n");
		const edits = createCstEdits();

		edits.remove({ caller: "inline", preserveLeading: true, statement: root.body.body[0]! });

		expect(printCst(root, edits)).toBe("return 2\n");
	});

	it("should drop indentation that follows a comment on the line above a removed statement", () => {
		expect.assertions(1);

		const root = parseCst("local a = 1 -- one\n\tlocal b = 2\nreturn a\n");
		const edits = createCstEdits();

		edits.remove({ caller: "inline", preserveLeading: true, statement: root.body.body[1]! });

		expect(printCst(root, edits)).toBe("local a = 1 -- one\nreturn a\n");
	});
});

describe("replacement conflicts", () => {
	it("should throw naming both callers when two replacements target one node", () => {
		expect.assertions(1);

		const root = parseCst("local x = 1\n");
		const edits = createCstEdits();
		const statement = root.body.body[0]!;
		edits.replace({
			caller: "rule-a",
			replacement: { text: "local x = 2" },
			target: statement,
		});

		expect(() => {
			edits.remove({ caller: "rule-b", preserveLeading: true, statement });
		}).toThrow("rule-b cannot replace the Local at 1:1: rule-a already replaced it");
	});
});

/** The first node of `type` in source order. */
function firstNodeOfType<Kind extends CstNode["type"]>(
	root: CstNode,
	type: Kind,
): Extract<CstNode, { type: Kind }> {
	return findNode(root, (node): node is Extract<CstNode, { type: Kind }> => isKind(node, type));
}

describe("node construction", () => {
	it("should splice a constructed statement list over a statement and re-parse", () => {
		expect.assertions(2);

		const root = parseCst("-- header\nlocal v = f()\nreturn v\n");
		const edits = createCstEdits();
		const parser = loadLuauParser();

		edits.replace({
			caller: "inline-functions",
			replacement: parser.constructStatements("local a = 1\nlocal v = a"),
			target: root.body.body[0]!,
		});
		const code = printCst(root, edits);

		expect(code).toBe("-- header\nlocal a = 1\nlocal v = a\nreturn v\n");
		expect(parser.parse(code).ok).toBe(true);
	});

	it("should map a splice inside a constructed subtree to the host node once the subtree is spliced", () => {
		expect.assertions(2);

		const source = "local v = f()\nreturn v\n";
		const root = parseCst(source);
		const edits = createCstEdits();
		const parser = loadLuauParser();
		const block = parser.constructStatements("local v = g()");

		edits.replace({
			caller: "inner",
			replacement: parser.constructExpression("1"),
			target: firstNodeOfType(block, "Call"),
		});
		edits.replace({ caller: "outer", replacement: block, target: root.body.body[0]! });
		const { code, segments } = printCstMapped(root, {
			edits,
			source: indexSourceBytes(source),
		});

		expect(code).toBe("local v = 1\nreturn v\n");
		expect(segmentAt(segments, { column: code.indexOf("1"), line: 1 }).original).toStrictEqual({
			column: 0,
			line: 1,
		});
	});

	it("should reject an expression snippet that does not parse", () => {
		expect.assertions(1);

		expect(() => loadLuauParser().constructExpression("1 +")).toThrow(
			"snippet does not parse: Expected identifier when parsing expression, got <eof>",
		);
	});

	it("should reject a snippet of two expressions", () => {
		expect.assertions(1);

		expect(() => loadLuauParser().constructExpression("1, 2")).toThrow(
			"snippet is not one expression: 1, 2",
		);
	});

	it("should reject an empty expression snippet", () => {
		expect.assertions(1);

		expect(() => loadLuauParser().constructExpression("")).toThrow(
			"snippet is not one expression: ",
		);
	});

	it("should splice a constructed expression over a call, re-parse, and map its tokens to the call's first token", () => {
		expect.assertions(3);

		const source = "local v = compute(1, 2) -- note\nreturn v\n";
		const root = parseCst(source);
		const edits = createCstEdits();
		const parser = loadLuauParser();

		edits.replace({
			caller: "inline",
			replacement: parser.constructExpression("a + b"),
			target: firstNodeOfType(root, "Call"),
		});
		const { code, segments } = printCstMapped(root, {
			edits,
			source: indexSourceBytes(source),
		});

		expect(code).toBe("local v = a + b -- note\nreturn v\n");
		expect(parser.parse(code).ok).toBe(true);
		expect([
			segmentAt(segments, { column: code.indexOf("a +"), line: 1 }).original,
			segmentAt(segments, { column: code.indexOf("b -"), line: 1 }).original,
		]).toStrictEqual([
			{ column: source.indexOf("compute"), line: 1 },
			{ column: source.indexOf("compute"), line: 1 },
		]);
	});
});
