import { describe, it } from "vitest";

import * as luauAst from "./index.ts";

describe("public package surface", () => {
	it("should expose parsing, editing, traversal and source helpers", ({ expect }) => {
		expect.assertions(5);

		expect(luauAst.createCstEdits).toBeTypeOf("function");
		expect(luauAst.indexSourceBytes).toBeTypeOf("function");
		expect(luauAst.loadLuauParser).toBeTypeOf("function");
		expect(luauAst.printCst).toBeTypeOf("function");
		expect(luauAst.walkCst).toBeTypeOf("function");
	});
});
