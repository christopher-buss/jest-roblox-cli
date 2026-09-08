import { assert, describe, expect, it } from "vitest";

import { printCst } from "./cst-print.ts";
import { forEachCstNode } from "./cst.ts";
import type { CstRoot } from "./cst.ts";
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

	it("should print explicit type instantiation byte-identical", () => {
		expect.assertions(1);

		// Kept out of the fixture set: Luau 0.731's own JSON encoder emits
		// malformed JSON for this construct, so it cannot re-parse via
		// parse_to_json.
		const source = "local a = f<<number, string>>(1)\nlocal b = f<< number >>\n";

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
});
