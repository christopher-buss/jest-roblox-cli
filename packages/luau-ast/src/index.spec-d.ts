import { describe, expectTypeOf, it } from "vitest";

import {
	createCstEdits,
	indexSourceBytes,
	loadLuauParser,
	printCst,
	renameBinding,
} from "./index.ts";
import type { CstEdits, CstNode, LuauParser, RenameOptions, SourceBytes } from "./index.ts";

describe("package interface", () => {
	it("should retain parser, editing, printing and byte-index signatures", () => {
		expectTypeOf(loadLuauParser).returns.toEqualTypeOf<LuauParser>();
		expectTypeOf(createCstEdits).returns.toEqualTypeOf<CstEdits>();
		expectTypeOf(indexSourceBytes).toEqualTypeOf<(source: string) => SourceBytes>();
		expectTypeOf(printCst).toEqualTypeOf<(root: CstNode, edits?: CstEdits) => string>();
		expectTypeOf(renameBinding).toEqualTypeOf<
			(root: CstNode, options: RenameOptions) => void
		>();
	});
});
