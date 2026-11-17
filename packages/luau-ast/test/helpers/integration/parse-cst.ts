import { loadLuauParser } from "@isentinel/luau-ast";
import type { CstRoot } from "@isentinel/luau-ast/cst";

export function parseCst(source: string): CstRoot {
	const result = loadLuauParser().parseCst({ fileName: "test.luau", source });
	if (!result.ok) {
		throw new Error(result.errors.join("\n"));
	}

	return result.root;
}
