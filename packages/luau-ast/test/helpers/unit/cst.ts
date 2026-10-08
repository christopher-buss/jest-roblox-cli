import type { CstNumber } from "../../../src/cst.ts";

export function numberNode(): CstNumber {
	return {
		location: { beginColumn: 1, beginLine: 1, endColumn: 2, endLine: 1 },
		token: { leading: [], text: "1", trailing: [] },
		type: "Number",
	};
}
