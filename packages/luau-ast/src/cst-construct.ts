import assert from "node:assert";

import type { CstParseResult } from "./cst-materialize.ts";
import { forEachToken } from "./cst.ts";
import type { CstBlock, CstExpr, CstNode, CstRoot } from "./cst.ts";
import type { CstParseOptions } from "./parser.ts";

type ParseCst = (options: CstParseOptions) => CstParseResult;

/**
 * Parse an expression snippet into a subtree ready to splice. The tokens
 * carry no origin: printed in a replaced node's place they map to that
 * node's first token.
 *
 * @param parse - The parser's CST entry.
 * @param snippet - One Luau expression.
 * @returns The expression node.
 */
export function constructExpression(parse: ParseCst, snippet: string): CstExpr {
	// A `return` must end its block, so anything that parses is one Return
	// statement; only its value count can be off.
	const [statement] = parseSnippet(parse, `return ${snippet}`).body.body;
	assert(statement?.type === "Return", "a return snippet parsed to something else");
	const [value, extra] = statement.values;
	if (value === undefined || extra !== undefined) {
		throw new Error(`snippet is not one expression: ${snippet}`);
	}

	return detach(value.node);
}

/**
 * Parse a statement-list snippet into a block ready to splice over a
 * statement. Trivia after the last statement's line goes with the
 * end-of-file token and is dropped.
 *
 * @param parse - The parser's CST entry.
 * @param snippet - Zero or more Luau statements.
 * @returns The block.
 */
export function constructStatements(parse: ParseCst, snippet: string): CstBlock {
	return detach(parseSnippet(parse, snippet).body);
}

function parseSnippet(parse: ParseCst, source: string): CstRoot {
	const result = parse({ fileName: "snippet", source });
	if (!result.ok) {
		throw new Error(`snippet does not parse: ${result.errors.join("; ")}`);
	}

	return result.root;
}

/** Strip the snippet positions: they mean nothing in the host tree. */
function detach<Node extends CstNode>(node: Node): Node {
	forEachToken(node, (token) => {
		delete token.origin;
	});

	return node;
}
