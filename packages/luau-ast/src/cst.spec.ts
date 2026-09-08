import { assert, describe, expect, it } from "vitest";

import { printCst } from "./cst-print.ts";
import { forEachCstNode, someCstNode, walkCst } from "./cst.ts";
import type { CstNode, CstRoot } from "./cst.ts";
import { loadLuauParser } from "./parser.ts";

function parseCst(source: string, fileName = "test.luau"): CstRoot {
	const result = loadLuauParser().parseCst({ fileName, source });
	if (!result.ok) {
		throw new Error(result.errors.join("\n"));
	}

	return result.root;
}

/**
 * Binding numbers of every declaration and reference named `name`, in source
 * order.
 */
function bindingsNamed(root: CstRoot, name: string): Array<number> {
	const bindings: Array<number> = [];
	forEachCstNode(root, (node) => {
		if ((node.type === "LocalDecl" || node.type === "LocalRef") && node.name.text === name) {
			bindings.push(node.binding);
		}
	});

	return bindings;
}

describe("parseCst", () => {
	it("should print a zero-edit tree byte-identical to its source", () => {
		expect.assertions(1);

		const source = "local x = 1 -- note\nreturn x\n";

		expect(printCst(parseCst(source))).toBe(source);
	});

	it("should report parse errors as an error result", () => {
		expect.assertions(1);

		const result = loadLuauParser().parseCst({ fileName: "bad.luau", source: "local = =" });

		assert(!result.ok);

		expect(result.errors[0]).toContain("Expected identifier");
	});
});

describe("binding identity", () => {
	it("should share one binding across a local's declaration and references", () => {
		expect.assertions(1);

		const root = parseCst("local x = 1\nx = x + 1\nprint(x)\n");

		const [declaration, ...references] = bindingsNamed(root, "x");

		expect(references).toStrictEqual([declaration!, declaration!, declaration!]);
	});

	it("should give a shadowing local a different binding from the outer one", () => {
		expect.assertions(2);

		const root = parseCst("local x = 1\ndo\n\tlocal x = 2\n\tprint(x)\nend\nprint(x)\n");

		const [outer, inner, innerRef, outerRef] = bindingsNamed(root, "x");

		expect([innerRef, outerRef]).toStrictEqual([inner, outer]);
		expect(inner).not.toBe(outer);
	});

	it("should bind a parameter separately from a same-named outer local", () => {
		expect.assertions(2);

		const root = parseCst("local v = 1\nlocal function f(v)\n\treturn v\nend\nreturn v\n");

		const [outer, parameter, parameterRef, outerRef] = bindingsNamed(root, "v");

		expect([parameterRef, outerRef]).toStrictEqual([parameter, outer]);
		expect(parameter).not.toBe(outer);
	});

	it("should bind a local referenced inside a typeof annotation to its declaration", () => {
		expect.assertions(1);

		const root = parseCst("local v = 1\nlocal w: typeof(v) = v\nreturn w\n");

		const [declaration, ...references] = bindingsNamed(root, "v");

		expect(references).toStrictEqual([declaration!, declaration!]);
	});
});

function isLocalStatement(node: CstNode): boolean {
	return node.type === "Local";
}

function isFunctionStatName(node: CstNode, slot: string): boolean {
	return node.type === "FunctionStat" && slot === "name";
}

function isStringNode(node: CstNode): boolean {
	return node.type === "String";
}

describe(walkCst, () => {
	it("should enter nodes before their children and exit after them", () => {
		expect.assertions(1);

		const events: Array<string> = [];
		walkCst(parseCst("return 1\n").body, {
			onExit: (node) => {
				events.push(`exit ${node.type}`);
			},
			onNode: (node) => {
				events.push(`enter ${node.type}`);
				return false;
			},
		});

		expect(events).toStrictEqual([
			"enter Block",
			"enter Return",
			"enter Number",
			"exit Number",
			"exit Return",
			"exit Block",
		]);
	});

	it("should skip a claimed node's children, and a slot on request", () => {
		expect.assertions(1);

		const visited: Array<string> = [];
		walkCst(parseCst("local Foo = {}\nfunction Foo.bar()\n\treturn Foo\nend\n").body, {
			onNode: (node) => {
				visited.push(node.type);
				return isLocalStatement(node);
			},
			skipSlot: isFunctionStatName,
		});

		expect(visited).toStrictEqual([
			"Block",
			"Local",
			"FunctionStat",
			"FunctionBody",
			"Block",
			"Return",
			"LocalRef",
		]);
	});
});

describe(someCstNode, () => {
	it("should stop at the first match", () => {
		expect.assertions(2);

		const seen: Array<string> = [];
		const isFound = someCstNode(parseCst("local a = 1\nlocal b = 2\n"), (node) => {
			seen.push(node.type);
			return node.type === "Number";
		});

		expect(isFound).toBe(true);
		expect(seen).toStrictEqual(["Root", "Block", "Local", "LocalDecl", "Number"]);
	});

	it("should report no match after a full walk", () => {
		expect.assertions(1);

		expect(someCstNode(parseCst("return 1\n"), isStringNode)).toBe(false);
	});
});
