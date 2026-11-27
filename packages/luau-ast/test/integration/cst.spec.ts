import { loadLuauParser, printCst } from "@isentinel/luau-ast";
import { forEachCstNode, isRecord, isToken, someCstNode, walkCst } from "@isentinel/luau-ast/cst";
import type { CstNode, CstRoot } from "@isentinel/luau-ast/cst";

import { assert, describe, it } from "vitest";

import { parseCst } from "#test/helpers/integration/parse-cst";

function bindingsNamed(root: CstRoot, name: string): Array<number> {
	const bindings: Array<number> = [];
	forEachCstNode(root, (node) => {
		if ((node.type === "LocalDecl" || node.type === "LocalRef") && node.name.text === name) {
			bindings.push(node.binding);
		}
	});

	return bindings;
}

function reverseKeys<T>(value: T): T;
function reverseKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(reverseKeys);
	}

	if (isToken(value) || !isRecord(value)) {
		return value;
	}

	return Object.fromEntries(
		Object.entries(value)
			.reverse()
			.map(([key, slot]) => [key, reverseKeys(slot)]),
	);
}

describe("parseCst", () => {
	it("should print a zero-edit tree byte-identical to its source", ({ expect }) => {
		expect.assertions(1);

		const source = "local x = 1 -- note\nreturn x\n";

		expect(printCst(parseCst(source))).toBe(source);
	});

	it("should report parse errors as an error result", ({ expect }) => {
		expect.assertions(1);

		const result = loadLuauParser().parseCst({ fileName: "bad.luau", source: "local = =" });

		assert(!result.ok);

		expect(result.errors[0]).toContain("Expected identifier");
	});
});

describe("binding identity", () => {
	it("should share one binding across a local's declaration and references", ({ expect }) => {
		expect.assertions(1);

		const root = parseCst("local x = 1\nx = x + 1\nprint(x)\n");

		const [declaration, ...references] = bindingsNamed(root, "x");

		expect(references).toStrictEqual([declaration!, declaration!, declaration!]);
	});

	it("should give a shadowing local a different binding from the outer one", ({ expect }) => {
		expect.assertions(2);

		const root = parseCst("local x = 1\ndo\n\tlocal x = 2\n\tprint(x)\nend\nprint(x)\n");

		const [outer, inner, innerRef, outerRef] = bindingsNamed(root, "x");

		expect([innerRef, outerRef]).toStrictEqual([inner, outer]);
		expect(inner).not.toBe(outer);
	});

	it("should scope an `if local` binding to its then branch", ({ expect }) => {
		expect.assertions(2);

		const root = parseCst(
			"local x = 1\nif local x = f() then\n\tprint(x)\nelse\n\tprint(x)\nend\n",
		);

		const [outer, condition, thenRef, elseRef] = bindingsNamed(root, "x");

		expect([thenRef, elseRef]).toStrictEqual([condition, outer]);
		expect(condition).not.toBe(outer);
	});

	it("should scope a `while local` binding to its body", ({ expect }) => {
		expect.assertions(2);

		const root = parseCst("local x = 1\nwhile local x = f(x) do\n\tprint(x)\nend\nreturn x\n");

		const [outer, condition, conditionRef, bodyRef, afterRef] = bindingsNamed(root, "x");

		expect([conditionRef, bodyRef, afterRef]).toStrictEqual([outer, condition, outer]);
		expect(condition).not.toBe(outer);
	});

	it("should bind a parameter separately from a same-named outer local", ({ expect }) => {
		expect.assertions(2);

		const root = parseCst("local v = 1\nlocal function f(v)\n\treturn v\nend\nreturn v\n");

		const [outer, parameter, parameterRef, outerRef] = bindingsNamed(root, "v");

		expect([parameterRef, outerRef]).toStrictEqual([parameter, outer]);
		expect(parameter).not.toBe(outer);
	});

	it("should bind a local referenced inside a typeof annotation to its declaration", ({
		expect,
	}) => {
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
	it("should visit slots in lexical order whatever the key order", ({ expect }) => {
		expect.assertions(1);

		const source = "type T = A | B\nlocal x = f(1, 2)\n";

		expect(printCst(reverseKeys(parseCst(source)))).toBe(source);
	});

	it("should enter nodes before their children and exit after them", ({ expect }) => {
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

	it("should skip a claimed node's children, and a slot on request", ({ expect }) => {
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

	it("should name a slot that holds no node, token, or list", ({ expect }) => {
		expect.assertions(1);

		const root = parseCst("return 1\n");
		const statement = root.body.body[0]!;
		assert(statement.type === "Return", "expected a return statement");
		Object.assign(statement.values[0]!.node, { token: 1 });

		expect(() => printCst(root)).toThrow("Number.token holds no node, token, or list");
	});
});

describe(someCstNode, () => {
	it("should stop at the first match", ({ expect }) => {
		expect.assertions(2);

		const seen: Array<string> = [];
		const isFound = someCstNode(parseCst("local a = 1\nlocal b = 2\n"), (node) => {
			seen.push(node.type);
			return node.type === "Number";
		});

		expect(isFound).toBeTrue();
		expect(seen).toStrictEqual(["Root", "Block", "Local", "LocalDecl", "Number"]);
	});

	it("should report no match after a full walk", ({ expect }) => {
		expect.assertions(1);

		expect(someCstNode(parseCst("return 1\n"), isStringNode)).toBeFalse();
	});
});
