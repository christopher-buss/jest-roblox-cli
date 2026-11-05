import { describe, expect, it } from "vitest";

import { buildAncestorChain } from "./ancestor-chain.ts";
import type { RawTestDefinition } from "./typecheck-types.ts";

function definition(
	type: RawTestDefinition["type"],
	{ name, end, start }: { end: number; name: string; start: number },
): RawTestDefinition {
	return { name, end, start, type };
}

describe(buildAncestorChain, () => {
	it("should name every open suite above each definition", () => {
		expect.assertions(1);

		const outer = definition("suite", { name: "outer", end: 100, start: 0 });
		const inner = definition("suite", { name: "inner", end: 50, start: 10 });
		const nested = definition("test", { name: "nested", end: 40, start: 20 });
		const sibling = definition("test", { name: "sibling", end: 90, start: 60 });
		const top = definition("test", { name: "top", end: 130, start: 110 });

		expect(buildAncestorChain([outer, inner, nested, sibling, top])).toStrictEqual([
			{ ...outer, ancestorNames: [] },
			{ ...inner, ancestorNames: ["outer"] },
			{ ...nested, ancestorNames: ["outer", "inner"] },
			{ ...sibling, ancestorNames: ["outer"] },
			{ ...top, ancestorNames: [] },
		]);
	});
});
