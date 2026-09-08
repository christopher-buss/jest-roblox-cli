import fs from "node:fs";
import path from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";

import { CST_NODE_KINDS } from "./cst.ts";
import type { CstNode, CstNodeKind } from "./cst.ts";

// The serializer names a node kind exactly once, in `begin("Kind", ...)`.
// Reading the C++ source keeps the TypeScript union from drifting without a
// wasm rebuild in the loop.
const WRAPPER_SOURCE = path.join(import.meta.dirname, "..", "wasm", "wrapper.cpp");
const BEGIN_CALL = /begin\(\s*"([A-Za-z]+)"/g;

describe("node kinds", () => {
	it("should list exactly the kinds the serializer emits", () => {
		expect.assertions(1);

		const emitted = new Set(
			Array.from(fs.readFileSync(WRAPPER_SOURCE, "utf8").matchAll(BEGIN_CALL), (match) => {
				return match[1]!;
			}),
		);

		expect(emitted).toStrictEqual(new Set(CST_NODE_KINDS));
	});

	it("should type the union with exactly the listed kinds", () => {
		expect.assertions(0);

		// Checked by the typecheck target: a kind on one side only is a
		// compile error here.
		expectTypeOf<CstNode["type"]>().toEqualTypeOf<CstNodeKind>();
	});
});
