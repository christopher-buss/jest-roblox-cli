import type {
	AstExpr,
	AstExprFunction,
	AstStatBlock,
	AstStatFunction,
	AstStatLocalFunction,
} from "@isentinel/luau-ast";

import type { LuauVisitor } from "../luau/visitor.ts";
import type { CoverageAccumulator, SourcePosition } from "./coverage-accumulator.ts";

export function getBodyFirstStatement(block: AstStatBlock): SourcePosition {
	const first = block.statements[0];
	if (first !== undefined) {
		return { column: first.location.beginColumn, line: first.location.beginLine };
	}

	// Empty body — use the block's own start position so the probe
	// inserter can place __cov_f / __cov_b inside the empty body.
	return { column: block.location.beginColumn, line: block.location.beginLine };
}

export function createFunctionCollector(accumulator: CoverageAccumulator): Partial<LuauVisitor> {
	// A named function's body is an `AstExprFunction` too, so the expression
	// visitor would count it a second time under `(anonymous)`.
	const namedFunctions = new Set<AstExprFunction>();

	return {
		visitExprFunction(node: AstExprFunction): boolean {
			if (namedFunctions.has(node)) {
				return true;
			}

			const first = getBodyFirstStatement(node.body);
			accumulator.addFunction("(anonymous)", node.location, first);

			return true;
		},

		visitStatFunction(node: AstStatFunction): boolean {
			const first = getBodyFirstStatement(node.func.body);
			namedFunctions.add(node.func);
			accumulator.addFunction(extractFunctionName(node), node.location, first);

			return true;
		},

		visitStatLocalFunction(node: AstStatLocalFunction): boolean {
			const first = getBodyFirstStatement(node.func.body);
			namedFunctions.add(node.func);
			accumulator.addFunction(node.name.name.text, node.location, first);

			return true;
		},
	};
}

function extractExprName(expr: AstExpr): string {
	if (expr.tag === "global") {
		return expr.name.text;
	}

	if (expr.tag === "indexname") {
		const object = extractExprName(expr.expression);
		const separator = expr.accessor.text;
		return `${object}${separator}${expr.index.text}`;
	}

	return "(anonymous)";
}

function extractFunctionName(node: AstStatFunction): string {
	return extractExprName(node.name);
}
