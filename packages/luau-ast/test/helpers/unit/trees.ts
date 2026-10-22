import { fromAny } from "@total-typescript/shoehorn";

import { assert } from "vitest";

import type { AstStatBlock } from "../../../src/ast-types.ts";
import type { CstRoot } from "../../../src/cst.ts";
import ast from "../../fixtures/trees/ast.json" with { type: "json" };
import cst from "../../fixtures/trees/cst.json" with { type: "json" };
import rawAst from "../../fixtures/trees/raw-ast.json" with { type: "json" };
import rawCst from "../../fixtures/trees/raw-cst.json" with { type: "json" };

export function astTree(source: string): AstStatBlock {
	const trees: Readonly<Record<string, AstStatBlock>> = fromAny(ast);
	const tree = trees[source];
	assert(tree !== undefined, `missing AST fixture for ${source}`);
	return structuredClone(tree);
}

export function cstTree(source: string): CstRoot {
	const trees: Readonly<Record<string, CstRoot>> = fromAny(cst);
	const tree = trees[source];
	assert(tree !== undefined, `missing CST fixture for ${source}`);
	return structuredClone(tree);
}

export function rawTree(source: string, kind: "ast" | "cst"): string {
	const trees: Readonly<Record<string, string>> = kind === "ast" ? rawAst : rawCst;
	const tree = trees[source];
	assert(tree !== undefined, `missing ${kind} payload for ${source}`);
	return tree;
}
