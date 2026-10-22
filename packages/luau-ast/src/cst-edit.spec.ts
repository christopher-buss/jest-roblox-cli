import { describe, expect, it } from "vitest";

import { numberNode } from "#test/helpers/unit/cst";
import { createCstEdits, renameBinding, renameBindings } from "./cst-edit.ts";
import type { CstBlock, CstLocal, CstLocalDeclaration, CstLocalRef } from "./cst.ts";

describe(createCstEdits, () => {
	it("should reject a second replacement naming both callers", () => {
		expect.assertions(1);

		const target = numberNode();
		const edits = createCstEdits();
		edits.replace({ caller: "first", replacement: { text: "2" }, target });

		expect(() => {
			edits.replace({ caller: "second", replacement: { text: "3" }, target });
		}).toThrow("second cannot replace the Number at 1:1: first already replaced it");
	});
});

function makeBindings() {
	const number = numberNode();
	function name() {
		return { leading: [], text: "x", trailing: [] };
	}

	const declaration = {
		name: name(),
		binding: 0,
		location: number.location,
		type: "LocalDecl",
	} satisfies CstLocalDeclaration;
	const reference = {
		name: name(),
		binding: 0,
		location: number.location,
		type: "LocalRef",
	} satisfies CstLocalRef;
	const shadow = {
		name: name(),
		binding: 1,
		location: number.location,
		type: "LocalRef",
	} satisfies CstLocalRef;
	const root = {
		keyword: name(),
		location: number.location,
		type: "Local",
		values: [{ node: reference }, { node: shadow }, { node: number }],
		variables: [{ node: declaration }],
	} satisfies CstLocal;
	return { declaration, reference, root, shadow };
}

describe("binding renames", () => {
	it("should rename declarations and references by identity while leaving shadowed names", () => {
		expect.assertions(2);

		const { declaration, reference, root, shadow } = makeBindings();

		renameBindings(root, new Map([[0, "renamed"]]));

		expect([declaration.name.text, reference.name.text, shadow.name.text]).toStrictEqual([
			"renamed",
			"renamed",
			"x",
		]);

		renameBinding(root, { name: "", binding: 1 });

		expect([declaration.name.text, reference.name.text, shadow.name.text]).toStrictEqual([
			"renamed",
			"renamed",
			"",
		]);
	});
});

describe("replacement ledger", () => {
	it("should retain replacements and callers by node identity", () => {
		expect.assertions(4);

		const target = numberNode();
		const edits = createCstEdits();
		const replacement = { text: "2" };

		expect(edits.replacementFor(target)).toBeUndefined();
		expect(edits.callerFor(target)).toBeUndefined();

		edits.replace({ caller: "replace", replacement, target });

		expect(edits.replacementFor(target)).toBe(replacement);
		expect(edits.callerFor(target)).toBe("replace");
	});

	it.for([false, true])("should retain removal policy %s", (preserveLeading) => {
		expect.assertions(2);

		const target = numberNode();
		const edits = createCstEdits();
		edits.remove({ caller: "remove", preserveLeading, statement: target });

		expect(edits.replacementFor(target)).toStrictEqual({ preserveLeading, remove: true });
		expect(edits.callerFor(target)).toBe("remove");
	});

	it("should stamp generated tokens without assigning an absent host origin", () => {
		expect.assertions(2);

		const replacement = numberNode();
		const target = {
			body: [],
			location: numberNode().location,
			type: "Block",
		} satisfies CstBlock;
		createCstEdits().replace({ caller: "generated", replacement, target });

		expect(replacement.token.generatedBy).toBe("generated");
		expect(replacement.token.origin).toBeUndefined();
	});

	it("should anchor nested replacements while preserving an existing attribution", () => {
		expect.assertions(4);

		const edits = createCstEdits();
		const target = numberNode();
		target.token.origin = { beginColumn: 3, beginLine: 2, endColumn: 4, endLine: 2 };
		const subtree = numberNode();
		const inner = numberNode();
		inner.token.generatedBy = "earlier";
		edits.replace({ caller: "inner", replacement: inner, target: subtree });
		edits.replace({ caller: "outer", replacement: subtree, target });

		expect(inner.token.origin).toBe(target.token.origin);
		expect(subtree.token.origin).toBe(target.token.origin);
		expect(inner.token.generatedBy).toBe("earlier");
		expect(subtree.token.generatedBy).toBe("outer");
	});

	it("should retain an existing subtree origin and avoid marking parsed tokens as generated", () => {
		expect.assertions(2);

		const target = numberNode();
		target.token.origin = target.location;
		const replacement = numberNode();
		const origin = { beginColumn: 8, beginLine: 4, endColumn: 9, endLine: 4 };
		replacement.token.origin = origin;
		createCstEdits().replace({ caller: "outer", replacement, target });

		expect(replacement.token.origin).toBe(origin);
		expect(replacement.token.generatedBy).toBeUndefined();
	});

	it("should retain a nested text replacement without treating it as a subtree", () => {
		expect.assertions(2);

		const edits = createCstEdits();
		const target = numberNode();
		target.token.origin = target.location;
		const subtree = numberNode();
		edits.replace({ caller: "inner", replacement: { text: "inner text" }, target: subtree });
		edits.replace({ caller: "outer", replacement: subtree, target });

		expect(subtree.token.origin).toBe(target.token.origin);
		expect(edits.replacementFor(subtree)).toStrictEqual({ text: "inner text" });
	});
});
